import { isProxy } from "node:util/types";
import { Ajv, type AnySchema } from "ajv";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { LEGACY_REQUIREMENTS, RESEARCH_CONTRACT_VERSION, REQUIREMENTS, UPSTREAM_STAGES, VERSION2_REQUIREMENTS, VERSION3_REQUIREMENTS, type UpstreamStage } from "../discovery/requirements.js";
import { QUESTION_MOMENTS, QUESTION_MOMENT_CONTRACT_VERSION } from "../discovery/preparation-contracts.js";
import { preparationFindings } from "../discovery/preparation-validation.js";
import { readAcceptedResearchAnswer } from "../discovery/discovery.js";
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import { runtimeEvidenceDependencies } from "../graph/runtime-evidence.js";
import { isRef, reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { ProductEngine } from "../product/engine.js";
import { readLegacyOperation } from "../product/preparation-run.js";
import { observeStore, Store, storeReads, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { gitCalls, uniqueTransactionGuards } from "../runtime/environment.js";
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";
import { deriveInputDecisions } from "./addressing.js";
import { answerSourceGuards, checkAnswerInputBody, prepareAnswerInvalidation, readAnswerForInput,
  readAnswerInvalidation, type AnswerInvalidation, type AnswerRequirementChange } from "./accepted-answer.js";

// Question deadlines do not introduce structured nodes or check kinds.
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
  questions: { id: string; question: string; consumer: string; kind: Json; blocks: boolean; source: Ref;
    moment?: typeof QUESTION_MOMENTS[number]; addressedBy?: Ref; originalConsumer?: string }[];
  facts?: AppliedInputFact[];
  map: { nodes: string[]; artifacts: string[]; connectors: string[] };
}
export interface AppliedInputFact { question: OmInput['questions'][number]; value: Json; answer: Ref; mc1Question: Ref }
export interface InputBuildResult { input: OmInput | null; hash: string | null; refusals: Refusal[]; gaps: InputGap[] }
export interface InputRequest { project: string; stages: Record<UpstreamStage, Ref>; inventory?: Ref | null; expected: number }
export interface DecisionInputDerivation { previous: Ref; graph: Ref; decisions: Ref[] }
export interface RefreshInputDerivation { kind: "refresh"; previous: Ref; stages: Record<UpstreamStage, Ref>; inventory: Ref | null }
export interface FactInputDerivation { kind: "fact"; previous: Ref; answer: Ref; question: Ref }
export interface ReopenFactDependency { record: Ref; question: Ref; removed: Ref[]; conditions: AnswerRequirementChange[] }
export interface ReopenFactInputDerivation { kind: "reopen-facts"; previous: Ref; invalidations: AnswerInvalidation[];
  dependencies?: ReopenFactDependency[] }
export type InputDerivation = DecisionInputDerivation | RefreshInputDerivation | FactInputDerivation | ReopenFactInputDerivation;
export interface OmInputRecord { projectId: string; input: OmInput; hash: string; gaps: InputGap[]; derivation?: InputDerivation }
export type DerivedInputRequest = { project: string } & (DecisionInputDerivation | FactInputDerivation | ReopenFactInputDerivation);
export interface PreparedOmInput<G extends TransactionGuard = Ref> { record: OmInputRecord; writes: Write[]; guards: G[]; existing: Revision<OmInputRecord> | null }
export const INPUT_REFRESH_CONFLICT = "input_refresh_conflict";

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

/** Current OM gates may carry positive admission refs; absence needs a different producer contract. */
export function readOmAdmissionGuards(value: unknown, gate: string, unit: "G1" | "G2" | "F4"): OmResult<Sealed<Ref[]>> {
  if (!text(gate) || !["G1", "G2", "F4"].includes(unit))
    throw new EngineError("om_admission_guard_invalid", "An admission channel needs its named gate and unit",
      { unit: "OM", target: "admissionGuards", field: !text(gate) ? "gate" : "unit" });
  let checked: TransactionGuard[];
  try { checked = uniqueTransactionGuards(value === undefined ? [] : value as TransactionGuard[]); }
  catch (error) {
    if (error instanceof EngineError && error.code === "invalid_guard")
      return refused("om_admission_guard_invalid", `${gate}: ${error.message}`,
        { unit, target: gate, field: "admissionGuards" }, "producer");
    throw error;
  }
  const refs: Ref[] = [];
  for (const guard of checked) {
    if ('absent' in guard)
      return refused("om_admission_guard_unsupported", `${gate} declares an absence not supported by this OM producer`,
        { unit, target: guard.id, field: `${gate}.admissionGuards` }, "producer");
    refs.push(guard);
  }
  return delivered(refs);
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
  // Check the new mandatory field before JSON normalization, including explicit undefined.
  for (const stage of ["discovery", "features"] as const) {
    if ((stages[stage].contractVersion ?? 0) < QUESTION_MOMENT_CONTRACT_VERSION) continue;
    const fields = stages[stage].fields;
    const lists = stage === "discovery"
      ? [{ rows: object(fields.preparation) ? (fields.preparation as Row).unknowns : undefined, field: "preparation.unknowns" }]
      : Array.isArray(fields.featurePreparation) ? fields.featurePreparation.map((prep, index) => ({
        rows: object(prep) ? (prep as Row).remainingQuestions : undefined, field: `featurePreparation[${index}].remainingQuestions` })) : [];
    for (const list of lists) if (Array.isArray(list.rows)) for (const [index, row] of list.rows.entries()) {
      if (object(row) && (!Object.hasOwn(row, "moment") || !(QUESTION_MOMENTS as readonly unknown[]).includes(row.moment)))
        fail("input_field_missing", stage, `${list.field}[${index}].moment`, "This producer contract requires an explicit recognized question moment");
    }
  }
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
      blocks: raw.blocksCurrentStage === true, source: stages[stage].ref,
      ...((stages[stage].contractVersion ?? 0) >= QUESTION_MOMENT_CONTRACT_VERSION ? { moment: raw.moment } : {}) });
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

const contractsByVersion = sealed({ 1: LEGACY_REQUIREMENTS, 2: VERSION2_REQUIREMENTS, 3: VERSION3_REQUIREMENTS, [RESEARCH_CONTRACT_VERSION]: REQUIREMENTS });
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
      for (const [index, question] of (questions as Revision<Row>[]).entries()) {
        const q = question.value;
        check(question.id.startsWith(`question:${request.project}:`) && q.projectId === request.project && q.stage === stage
          && q.draftId === draftRecord.id && q.status === "answered" && isRef(q.answer), "questions", "Every research question must have its own saved answer");
        const answerRecord = proof(q.answer), answer = answerRecord.value;
        check(answer.projectId === request.project && answer.question === question.id && answerRecord.id.startsWith(`${answerRecord.kind}:${request.project}:`)
          && (answerRecord.kind === q.spec.kind || answerRecord.kind === "research-answer"), "answers", "The answer belongs to another question, project or kind");
        let answered: Json;
        if (answerRecord.kind === "fact") answered = observation(answer.observation);
        else if (answerRecord.kind === "research-answer") {
          // D8.4.2 (№2230): provenance through the common reader — a managed answer proves its own
          // turn's K (the transitive reads join this B1 trail through the traced store); the exact
          // K must already sit in the stage's saved proofs (it lands there from gate's guards).
          const accepted = readAcceptedResearchAnswer(store, request.project, q.answer);
          if (accepted.binding) proof(reference(accepted.binding), "research-acceptance-binding");
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
        // The full ordered specs were checked against this era above. Reuse their stable schema objects:
        // Ajv retains freshly decoded schemas by identity, so compiling each historical copy leaks validators.
        check(canonical(answered) === canonical(draft.fields[q.spec.field]) && schemas.compile(specs[index]!.schema as AnySchema)(answered),
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
        if (version === 3 || version === 4) {
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
    const admission = readOmAdmissionGuards(projection.admissionGuards, "pipeline.features", "G1");
    if (!admission.ok) return admission;
    if (projection.state !== "accepted") {
      const finding = projection.findings[0];
      return refused("stage_not_accepted", finding?.message ?? "The current stages are not accepted",
        at(finding?.target ?? request.stages.features.id, finding?.field ?? finding?.code ?? "status", request.stages.features), "producer");
    }
    for (const ref of [...projection.guards, ...admission.value]) remember(ref);
    return delivered(sorted([...heads.values()]));
  } catch (error) {
    if (error instanceof EngineError && error.code === "input_stale")
      return refused("input_stale", error.message, error.details as ReturnType<typeof at>, "producer");
    throw error;
  }
}

export function prepareOmInput(store: Store, request: InputRequest): OmResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  return withHistoricalReads(() => prepareOmInputInScope(store, request));
}
function prepareOmInputInScope(store: Store, request: InputRequest): OmResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  requireInputRequest(store, request);
  request = copy(request);
  const id = `om-input:${request.project}`, current = store.get<OmInputRecord>(id);
  const initialGuards: TransactionGuard[] = [];
  if (!current) {
    const operation = readLegacyOperation(store, request.project);
    if (operation?.value.state === "active")
      return refused("legacy_operation_active", "The first OM input requires the legacy operation to finish",
        at(operation.id, "state", reference(operation)), "producer");
    initialGuards.push(operation ? reference(operation) : { id: `legacy-operation:${request.project}`, absent: true });
  }
  const derived = deriveInputRecord(store, request);
  if (!derived.ok) return derived;
  const checked = current && current.revision === request.expected
    ? readOmInput(store, request.project, reference(current)) : null;
  if (checked && !checked.ok) return checked;
  // A refreshed independent source must not erase accepted decisions. Both the previous version and
  // the requested root are rebuilt before carrying their checked content into a refresh derivation.
  if (current && checked?.ok && Object.hasOwn(checked.value.value, "derivation")) {
    if (canonical(checked.value.value.input.sources) === canonical(derived.value.input.sources)
      && canonical(checked.value.value.input.inventory) === canonical(derived.value.input.inventory))
      return prepareExistingOmInput(store, request.project, reference(current));
    const refreshed = refreshInputRecord(store, checked.value as Revision<OmInputRecord>, derived.value as OmInputRecord);
    if (!refreshed.ok) return refreshed;
    const acceptance = currentAcceptance(store, request);
    if (!acceptance.ok) return acceptance;
    const facts = currentFactGuards(store, refreshed.value as OmInputRecord);
    if (!facts.ok) return facts;
    return delivered({ record: refreshed.value, existing: null,
      writes: [{ id, kind: "om-input", expected: request.expected, value: refreshed.value }],
      guards: [...acceptance.value, ...facts.value, reference(current)] });
  }
  const acceptance = currentAcceptance(store, request);
  if (!acceptance.ok) return acceptance;
  const record = derived.value;
  const guards = [...acceptance.value];
  const existing = current?.kind === "om-input" && current.revision === request.expected && canonical(current.value) === canonical(record) ? current : null;
  return delivered({ record, existing, writes: existing ? [] : [{ id, kind: "om-input", expected: request.expected, value: record }],
    guards: [...guards, ...(existing ? [reference(existing)] : []), ...initialGuards] });
}

export function writeOmInput(store: Store, request: InputRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => writeOmInputInScope(store, request));
}
function writeOmInputInScope(store: Store, request: InputRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  const prepared = prepareOmInput(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.existing) return delivered(prepared.value.existing);
  const result = writeGuarded<OmInputRecord>(store, { unit: "G1", target: `om-input:${request.project}`,
    writes: prepared.value.writes as Write[], guards: prepared.value.guards });
  if (!result.ok) return result;
  return delivered(result.value[0]!);
}

export interface HistoricalReadKey { reader: string; project: string; ref: Ref; parameters?: Json }
type ReadObservation = { source: Store; method: 'get' | 'list' | 'history'; id: string | undefined; revision: number | undefined; references: Ref[] };
/** `stamp`: the change stamp of the source's genuine Store under which `signature` is known to hold (S1.3), or null
 * when the source has no such Store. Events are shared by every enclosing journal, so one check serves them all. */
type ReadEvent = ReadObservation & { signature: string; mutable: boolean; observations: ReadObservation[]; stamp: string | null; key?: string };
/** `accounted`: physical Store reads this journal traced (its own and its nested proofs'); `complete`: every read of the
 * proof and of every proof nested in it was traced and none of them ran git — the only journal whose footprint is its
 * whole dependency area. */
interface ReadJournal {
  entries: (ReadEvent | ReadJournal)[]; sources: Set<Store>; footprint: ReadEvent[]; accounted: number; complete: boolean;
  /** A write was attempted or an opaque view answered while this proof ran (S1.4, №2302-2, №2395); change stamps its observed Stores had before their reads;
   * the Stores those reads came from — apart from `sources`, which decide replay through a view and never see them. */
  tainted: boolean; stamps: Map<Store, string | null>; stores: Set<Store>;
  /** A listed reader over the proven family of a genuine Store: its closure reads are observed (S1.4, №2410). */
  observing: boolean;
}
interface HistoricalProof { value: unknown; events: ReadJournal; footprint: ReadEvent[]; complete: boolean }
interface HistoricalView { active: Set<string>; proven: Map<string, HistoricalProof> }
interface HistoricalTrace { source: Store; observe: ((ref: Ref, head: boolean, method: ReadEvent['method']) => void) | undefined; mode: 'ordered' | 'distinct'; seen: Set<string>; journals: WeakSet<ReadJournal> }
const historicalTraces = new WeakMap<Store, HistoricalTrace>();
// Only internally constructed, frozen overlays qualify; an arbitrary Proxy has no snapshot guarantee.
const historicalSnapshots = new WeakSet<Store>();
let historicalViews: WeakMap<Store, HistoricalView> | null = null;
let proofCaptures: ReadJournal[] = [];
let readStack: ReadObservation[][] = [];
let checkingFootprint = 0;
let proofStarts = 0;
function synchronous<T>(action: () => T): T {
  if (typeof action !== "function") invalid("history.action");
  const result = action();
  if (result !== null && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") invalid("history.async");
  return result;
}
function sourceView(store: Store): Store {
  for (;;) { const trace = historicalTraces.get(store); if (!trace) return store; store = trace.source; }
}
/** One identity of a source in proof keys, events and replay (№2194-3): the genuine Store beneath proven write-only
 * views, whose reads are exactly its reads; any other source keeps its own identity. */
function sourceIdentity(store: Store): Store {
  const source = sourceView(store);
  return provenStore(source) ?? source;
}
/**
 * S1.3 (№2185-4, №2194): proofs kept across the operations of one genuine Store instance. One H1 transition runs many
 * operations, and each used to derive the same exact histories again. Only a complete, successful, cacheable proof
 * whose every read came from that Store, and whose value is plain data, is kept; every reuse re-checks its footprint
 * (change stamp, identities). A frozen value is shared; any other is handed out as an independent copy, so no later
 * operation receives an object another may change. Bounded; a new Store or a restart starts cold.
 */
const RETAINED_LIMIT = 512;
const retainedProofs = new WeakMap<Store, Map<string, HistoricalProof & { frozen: boolean }>>();
/** Plain data only — no functions, symbols, accessors or instances whose state a copy would not carry. */
function plainValue(value: unknown, frozen: { all: boolean }, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
  if (seen.has(value)) return true;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (!Object.isFrozen(value)) frozen.all = false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key === 'symbol' || !('value' in descriptor) || !plainValue(descriptor.value, frozen, seen)) return false;
  }
  return true;
}
function retainedArea(source: Store): Map<string, HistoricalProof & { frozen: boolean }> | null {
  if (provenStore(source) !== source) return null;
  let area = retainedProofs.get(source);
  if (!area) { area = new Map(); retainedProofs.set(source, area); }
  return area;
}
function traceObservers(store: Store): HistoricalTrace[] {
  const observers: HistoricalTrace[] = [];
  for (;;) {
    const trace = historicalTraces.get(store); if (!trace) return observers.reverse();
    if (trace.observe) observers.push(trace);
    store = trace.source;
  }
}
function observeReference(trace: HistoricalTrace, ref: Ref, head: boolean, method: ReadEvent['method']): void {
  if (trace.mode === 'distinct') {
    const key = canonical([ref, head, method]);
    if (trace.seen.has(key)) return;
    trace.seen.add(key);
  }
  trace.observe?.({ ...ref }, head, method);
}
function recordRead(event: ReadEvent | ReadJournal): void {
  if (!checkingFootprint) proofCaptures.at(-1)?.entries.push(event);
}
function readSignature(source: Store, records: readonly Revision<unknown>[]): string {
  return digest(canonical(isProxy(source) && !historicalSnapshots.has(source) ? records : records.map(row => ({ ...reference(row), kind: row.kind }))));
}
/**
 * S1.4 (№2410, C1/C2): the readers whose untraced action is observed at the Store and may be kept on that observation.
 * Each was audited: its action reads only the Store it was given as root (directly or through the common readers it
 * calls with that Store) and values derived from its key — no overlay, preview, projection or other Store captured from
 * outside, no file, environment, clock or randomness; git is counted (№2217). An overlay a reader builds inside its
 * action from those values is rebuilt by every derivation. Every other historicalRead keeps the S1.3 semantics: a
 * closure read is not accounted and the proof is not kept beyond its operation.
 */
const OBSERVED_READERS: ReadonlySet<string> = new Set([
  'G7.completion-assignment', 'G7.completion-work', 'G7.completion-cessation', 'G7.completion-owner', 'G7.completion-close',
  'G7.answers-assignment', 'A3.series-history', 'A3.3.full-gaps', 'A3.3.mechanism-slice', 'A3.3.mechanism-admission',
  'E2.question-packet', 'E4.model-call-state', 'M6.route-result',
]);
/**
 * S1.4 (№2302): the Store's own implementation reports every completed read and every write attempt, so a proof whose
 * action reads a closure-captured Store journals those reads too. A read inside a traced read is that read's own; a read
 * checking a footprint is only accounted, never a new dependency. Such an event carries no observation: a cold action
 * reading around a trace shows it nothing, and neither does its replay (№2302-4).
 */
observeStore({
  begin(store) {
    const capture = historicalViews && !readStack.length ? proofCaptures.at(-1) : undefined;
    // Checking a footprint is accounted for any proof; a closure read only for an observed reader (C1/C2).
    if (!capture || !(checkingFootprint || capture.observing)) return undefined;
    // Taken before the first read: a commit after it can only make the stamp older, never mask a change.
    if (capture && !checkingFootprint && !capture.stamps.has(store)) capture.stamps.set(store, provenStore(store) === store ? store.changeStamp() : null);
    return capture;
  },
  end(token, store, _method, mode, id, revision, rows) {
    const capture = token as ReadJournal;
    capture.accounted++;
    if (checkingFootprint) return;
    // Identities carry the same {id, revision, hash, kind} a genuine source's signature is made of.
    const records = rows as Revision<unknown>[];
    capture.entries.push({ source: store, method: mode, id, revision, references: records.map(reference), observations: [],
      stamp: capture.stamps.get(store) ?? null, signature: readSignature(store, records),
      mutable: mode !== 'get' || revision === undefined || !records.length });
  },
  write() { for (const capture of proofCaptures) capture.tainted = true; },
  // An opaque view answered (№2395): every enclosing proof is incomplete; checking a footprint is no such read.
  untraced() { if (!checkingFootprint) for (const capture of proofCaptures) capture.tainted = true; },
});
function observedRead<T>(store: Store, method: ReadEvent['method'], id: string | undefined, revision: number | undefined, action: () => T): T {
  // Taken before the read: a commit between the stamp and the read can only make the stamp older, never mask a change.
  const recorded = !readStack.length && !checkingFootprint && historicalViews !== null && proofCaptures.length > 0;
  const stamp = recorded ? provenStore(sourceView(store))?.changeStamp() ?? null : null;
  const outermost = !readStack.length, reads = storeReads(), starts = proofStarts;
  const observations: ReadObservation[] = []; readStack.push(observations);
  let value: T;
  try { value = action(); } finally {
    readStack.pop();
    // A proof run inside this read accounts for itself; then this read's own count is left unaccounted (never twice).
    const capture = outermost && !checkingFootprint && proofStarts === starts ? proofCaptures.at(-1) : undefined;
    if (capture) capture.accounted += storeReads() - reads;
  }
  const records = (method === 'get' ? value === null ? [] : [value] : value) as Revision<unknown>[];
  const refs = records.map(reference), source = sourceIdentity(store);
  const trace = historicalTraces.get(store)!;
  if (!checkingFootprint && trace.observe) for (const ref of refs) observeReference(trace, ref, method === 'get' && revision === undefined, method);
  // Transparent wrappers observe one call; an opaque view may answer without reaching its source collector.
  const child = observations.at(-1);
  if (!child || child.source !== source || child.method !== method || child.id !== id || child.revision !== revision)
    observations.push({ source, method, id, revision, references: refs });
  if (readStack.length) readStack.at(-1)!.push(...observations);
  else if (!checkingFootprint && historicalViews && proofCaptures.length) {
    recordRead({ source, method, id, revision, references: refs, observations, stamp,
      signature: readSignature(source, records), mutable: isProxy(source) && !historicalSnapshots.has(source) || method !== 'get' || revision === undefined || value === null });
  }
  return value;
}
/** Construct, rather than trust a claim about, a transparent source view. Opaque/pending views keep their identity. */
export function historicalTrace(store: Store, observe?: (ref: Ref, head: boolean, method: ReadEvent['method']) => void,
  mode: 'ordered' | 'distinct' = 'ordered'): Store {
  if (!(store instanceof Store) || (observe !== undefined && typeof observe !== 'function') || !['ordered', 'distinct'].includes(mode)) invalid('history.trace');
  const view = new Proxy(store, { get(target, key) {
    if (key === 'get') return <T>(id: string, revision?: number): Revision<T> | null =>
      observedRead(view, 'get', id, revision, () => target.get<T>(id, revision));
    if (key === 'list') return <T>(kind?: string): Revision<T>[] => observedRead(view, 'list', kind, undefined, () => target.list<T>(kind));
    if (key === 'history') return <T>(id: string): Revision<T>[] => observedRead(view, 'history', id, undefined, () => target.history<T>(id));
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  historicalTraces.set(view, { source: store, observe, mode, seen: new Set(), journals: new WeakSet() });
  return view;
}
function completeJournal(journal: ReadJournal): void {
  const checked = new WeakMap<Store, Set<string>>();
  const remember = (event: ReadEvent) => {
    let keys = checked.get(event.source); if (!keys) { keys = new Set(); checked.set(event.source, keys); }
    const key = event.key ??= canonical([event.method, event.id ?? null, event.revision ?? null, event.signature]);
    if (!keys.has(key)) { keys.add(key); journal.footprint.push(event); }
  };
  // Child journals are already complete. Repeated edges retain multiplicity without copying their leaves.
  const children = new Set<ReadJournal>();
  for (const entry of journal.entries) {
    if ('entries' in entry) {
      if (children.has(entry)) continue;
      children.add(entry);
      for (const source of entry.sources) journal.sources.add(source);
      for (const store of entry.stores) journal.stores.add(store);
      for (const event of entry.footprint) remember(event);
    } else {
      if (!entry.observations.length) journal.stores.add(entry.source);
      for (const observation of entry.observations) journal.sources.add(observation.source);
      if (entry.mutable) remember(entry);
    }
  }
}
/**
 * S1.3 (№2185): a dependency of a genuine Store is read again only when that Store's change stamp moved since the
 * dependency was last proved, and then only as identities — the same rows, never decoded. A proved event keeps its new
 * stamp, so a dependency shared by nested proofs is checked once per change, not once per path through the proof tree.
 * Sources without a genuine Store (overlays, captures, subclasses, arbitrary views) keep the full read below.
 */
function currentFootprint(footprint: readonly ReadEvent[]): boolean {
  checkingFootprint++;
  const stamps = new Map<Store, string>();
  try {
    for (const event of footprint) {
      const genuine = event.stamp === null ? null : provenStore(event.source);
      if (genuine) {
        let now = stamps.get(genuine);
        // A Store closed since (S1.4: an observed closure read of another Store) is no current source: derive again.
        try {
          if (now === undefined) { now = genuine.changeStamp(); stamps.set(genuine, now); }
          if (event.stamp === now) continue;
          if (digest(canonical(genuine.identities(event.method, event.id, event.revision))) !== event.signature) return false;
        } catch { return false; }
        event.stamp = now;
        continue;
      }
      const records = event.method === 'get' ? (() => { const row = event.source.get<unknown>(event.id!, event.revision); return row ? [row] : []; })()
        : event.method === 'list' ? event.source.list<unknown>(event.id) : event.source.history<unknown>(event.id!);
      if (readSignature(event.source, records) !== event.signature) return false;
    }
    return true;
  } finally { checkingFootprint--; }
}
function replayProof(store: Store, events: ReadJournal): void {
  const source = sourceIdentity(store), observers = traceObservers(store);
  const replay = (journal: ReadJournal, active: HistoricalTrace[]): void => {
    if (!journal.sources.has(source)) return;
    const collecting = active.filter(trace => trace.mode === 'ordered' || !trace.journals.has(journal));
    if (!collecting.length) return;
    for (const trace of collecting) if (trace.mode === 'distinct') trace.journals.add(journal);
    for (const entry of journal.entries) {
      if ('entries' in entry) replay(entry, collecting);
      else for (const observation of entry.observations) if (observation.source === source)
        for (const trace of collecting) for (const ref of observation.references)
          observeReference(trace, ref, observation.method === 'get' && observation.revision === undefined, observation.method);
    }
  };
  // Ordered observers receive the full stream; declared sets visit shared subproofs only once.
  if (observers.length) replay(events, observers);
  recordRead(events);
}
/** Share exact proofs for one synchronous product operation; heads and current admission stay fresh. */
export function withHistoricalReads<T>(action: () => T): T {
  if (historicalViews) return synchronous(action);
  historicalViews = new WeakMap();
  try { return synchronous(action); }
  finally { historicalViews = null; proofCaptures = []; }
}
function useHistoricalProof<T>(store: Store, key: HistoricalReadKey, action: (source: Store) => T,
  onCycle: () => T, cacheable: (value: T) => boolean, traced: boolean): T {
  if (!(store instanceof Store) || !object(key) || !text(key.reader) || !text(key.project) || !isRef(key.ref)
    || typeof action !== 'function' || typeof onCycle !== 'function' || typeof cacheable !== 'function') invalid('history');
  const exact = canonical(key);
  return withHistoricalReads(() => {
    const views = historicalViews!, source = sourceIdentity(store);
    let view = views.get(source);
    if (!view) { view = { active: new Set(), proven: new Map() }; views.set(source, view); }
    if (view.active.has(exact)) return synchronous(onCycle);
    const area = retainedArea(source), kept = view.proven.has(exact) ? undefined : area?.get(exact);
    // A traced caller replays a proof to its observers; one derived through a closure read shows them nothing (S1.4).
    if (kept && (!(traced || historicalTraces.has(store)) || kept.complete)) {
      // Another operation proved it: it serves this one only while its whole footprint is current.
      area!.delete(exact);
      if (currentFootprint(kept.footprint)) {
        area!.set(exact, kept);
        const adopted = { ...kept, value: kept.frozen ? kept.value : structuredClone(kept.value) };
        view.proven.set(exact, adopted);
        replayProof(store, adopted.events);
        return adopted.value as T;
      }
    }
    const complete = traced || historicalTraces.has(store), previous = view.proven.get(exact);
    // An untraced action is observed at the Store (S1.4, №2302, №2410): only a listed reader over the proven family of a
    // genuine Store; every other one keeps the S1.3 semantics.
    const observing = OBSERVED_READERS.has(key.reader) && provenStore(source) === source, observable = complete || observing;
    if (previous && (!complete || previous.complete)) {
      if (currentFootprint(previous.footprint)) { replayProof(store, previous.events); return previous.value as T; }
      // A proof of a genuine Store is checked on its own at every use, so only the moved one goes (S1.3). A mutable opaque
      // view now exposes another snapshot: no proof of its previous snapshot survives.
      if (area) view.proven.delete(exact);
      else view.proven.clear();
    }
    view.active.add(exact);
    const events: ReadJournal = { entries: [], sources: new Set(), footprint: [], accounted: 0, complete: false, tainted: false, stamps: new Map(), stores: new Set(), observing };
    proofCaptures.push(events);
    const reads = storeReads(), gits = gitCalls(); proofStarts++;
    let completed = false;
    try {
      const result = synchronous(() => action(traced ? historicalTrace(store) : store));
      // Replaying through an opaque forwarding view must not bypass collectors hidden behind that view.
      completeJournal(events); completed = true;
      // Complete only if every physical read of this action was traced, it ran no git (№2217) and every nested journal —
      // derived here or taken from a cache — is complete too (№2201): a dependency outside the Store travels to every parent.
      events.complete = observable && !events.tainted && storeReads() - reads === events.accounted && gitCalls() === gits
        && events.entries.every(entry => !('entries' in entry) || entry.complete);
      const replayable = !isProxy(source) || [...events.sources].every(observed => observed === source);
      if (replayable && !(object(result) && result.ok === false) && cacheable(result)) {
        const proof = { value: result, events, footprint: events.footprint, complete };
        view.proven.set(exact, proof);
        // Kept beyond this operation only with its full dependency area: a complete journal of this Store alone — never on
        // an empty trail, which proves no dependency at all, only that none reached the Store (№2302, card).
        const frozen = { all: true };
        if (area && events.complete && events.entries.length > 0 && [...events.sources].every(observed => observed === source)
          && [...events.stores].every(observed => observed === source) && plainValue(result, frozen)) {
          area.set(exact, { ...proof, value: frozen.all ? result : structuredClone(result), frozen: frozen.all });
          for (const oldest of area.keys()) { if (area.size <= RETAINED_LIMIT) break; area.delete(oldest); }
        }
      }
      return result;
    } finally {
      if (!completed) completeJournal(events);
      proofCaptures.pop(); recordRead(events); view.active.delete(exact);
      // The parent's own count includes these reads; what this proof traced is traced for the parent as well.
      const parent = proofCaptures.at(-1);
      if (parent) parent.accounted += events.accounted;
    }
  });
}
/** Existing historical readers retain their interface; traced callers also retain their dependency journal. */
export function historicalRead<T>(store: Store, key: HistoricalReadKey, action: () => T,
  onCycle: () => T, cacheable: (value: T) => boolean = value => !(object(value) && value.ok === false)): T {
  return useHistoricalProof(store, key, action, onCycle, cacheable, false);
}
/** The callback uses this source for every read, so even a cold proof records its full transitive dependencies. */
export function historicalProof<T>(store: Store, key: HistoricalReadKey, action: (source: Store) => T,
  onCycle: () => T, cacheable: (value: T) => boolean = value => !(object(value) && value.ok === false)): T {
  return useHistoricalProof(store, key, action, onCycle, cacheable, true);
}

export function readOmInput(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    requireInputRequest(store, { project, stages: {} as InputRequest['stages'], expected: 0 });
    if (!isRef(ref)) return readInputRecord(store, project, ref);
    return historicalProof(store, { reader: "B1.readOmInput", project, ref }, source => readInputRecord(source, project, ref),
      () => refused("record_forged", "Input sources contain a cyclic derivation", at(ref.id, "derivation", ref), "producer"), value => value.ok);
  });
}

function readInputRecord(store: Store, project: string, ref: Ref): OmResult<Sealed<Revision<OmInputRecord>>> {
  requireInputRequest(store, { project, stages: {} as InputRequest['stages'], expected: 0 });
  const read = readRecord<OmInputRecord>(store, ref, { unit: "G1", target: `om-input:${project}`, id: `om-input:${project}`, kind: "om-input" });
  if (!read.ok) return read;
  const body = read.value.value;
  if (!object(body) || body.projectId !== project || !object(body.input) || !Array.isArray(body.input.sources)
    || body.input.sources.length !== INPUT_STAGES.length || !Array.isArray(body.gaps))
    return refused("record_forged", "OM input has an incomplete saved source set", at(ref.id, "sources", ref), "producer");
  if (Object.hasOwn(body, "derivation")) {
    const lineage: unknown = body.derivation;
    if (!object(lineage) || !isRef(lineage.previous) || lineage.previous.id !== ref.id || lineage.previous.revision !== ref.revision - 1)
      return refused("record_forged", "Derived input needs its immediately preceding exact input", at(ref.id, "derivation", ref), "producer");
    let rebuilt: OmResult<Sealed<OmInputRecord>>;
    if (lineage.kind === "fact") {
      if (!isRef(lineage.answer) || !isRef(lineage.question))
        return refused("record_forged", "An applied fact needs its exact accepted answer and MC1 question", at(ref.id, "derivation", ref), "producer");
      rebuilt = deriveOmInput(store, { project, kind: "fact", previous: lineage.previous, answer: lineage.answer, question: lineage.question });
    } else if (lineage.kind === "reopen-facts") {
      const invalidations = normalizedInvalidations(lineage.invalidations);
      if (!invalidations) return refused("record_forged", "Reopening facts needs a nonempty, unambiguous set of exact invalidations",
        at(ref.id, "derivation.invalidations", ref), "producer");
      const dependencies = Object.hasOwn(lineage, "dependencies") ? normalizedDependencies(lineage.dependencies) : undefined;
      if (dependencies === null) return refused("record_forged", "Dependent recovery needs exact, unambiguous causes",
        at(ref.id, "derivation.dependencies", ref), "producer");
      rebuilt = deriveOmInput(store, { project, kind: "reopen-facts", previous: lineage.previous, invalidations,
        ...(dependencies ? { dependencies } : {}) });
    } else if (Object.hasOwn(lineage, "kind")) {
      if (lineage.kind !== "refresh" || !object(lineage.stages) || INPUT_STAGES.some(stage => !isRef(lineage.stages[stage]))
        || (lineage.inventory !== null && !isRef(lineage.inventory)))
        return refused("record_forged", "A refresh needs explicit exact stages and inventory", at(ref.id, "derivation", ref), "producer");
      const previous = readOmInput(store, project, lineage.previous);
      if (!previous.ok) return previous;
      const root = deriveInputRecord(store, { project, stages: lineage.stages as InputRequest['stages'], inventory: lineage.inventory, expected: 0 });
      if (!root.ok) return root;
      rebuilt = refreshInputRecord(store, previous.value as Revision<OmInputRecord>, root.value as OmInputRecord);
    } else {
      if (!isRef(lineage.graph) || !Array.isArray(lineage.decisions) || !lineage.decisions.every(isRef))
        return refused("record_forged", "Addressed input needs its exact graph and decisions", at(ref.id, "derivation", ref), "producer");
      rebuilt = deriveOmInput(store, { project, previous: lineage.previous, graph: lineage.graph, decisions: lineage.decisions });
    }
    if (!rebuilt.ok) return rebuilt;
    if (canonical(rebuilt.value) !== canonical(body))
      return refused("record_forged", "Addressed input must derive from its exact previous input and checked decisions", at(ref.id, "derivation", ref), "producer");
    return delivered(read.value);
  }
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
  // Genuine stage-only history stays valid, but a later root cannot erase an already checked decision
  // chain merely by omitting derivation. Walking exact predecessors also catches repeated stripped roots.
  if (ref.revision > 1) {
    const prior = store.get<OmInputRecord>(ref.id, ref.revision - 1);
    if (!prior || prior.kind !== "om-input")
      return refused("record_forged", "An input revision needs its exact preceding input", at(ref.id, "previous", ref), "producer");
    const previous = readOmInput(store, project, reference(prior));
    if (!previous.ok) return previous;
    if (previous.value.value.derivation)
      return refused("record_forged", "A stage-only root cannot erase accepted input decisions", at(ref.id, "derivation", ref), "producer");
  }
  return delivered(read.value);
}

// Both arguments have passed their source-derived historical readers. Inventory is the only independent
// root source here: a stage change needs a separate resolution, never an implicit reset of D3 fields.
function refreshInputRecord(store: Store, previous: Revision<OmInputRecord>, root: OmInputRecord): OmResult<Sealed<OmInputRecord>> {
  if (canonical(previous.value.input.sources) !== canonical(root.input.sources))
    return refused(INPUT_REFRESH_CONFLICT, "Changed stage sources require an explicit resolution of the accepted input decisions",
      at(previous.id, "sources", reference(previous)), "producer");
  const input = { ...previous.value.input, inventory: root.input.inventory };
  const gaps = sorted([...previous.value.gaps.filter(gap => gap.code !== "inventory_missing"),
    ...root.gaps.filter(gap => gap.code === "inventory_missing")]);
  const stages = Object.fromEntries(root.input.sources.map(source => [source.stage,
    { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'];
  const body: OmInputRecord = { projectId: root.projectId, input, hash: hashJson(input), gaps,
    derivation: { kind: "refresh", previous: reference(previous), stages, inventory: root.input.inventory } };
  const checked = checkFactContracts(store, body);
  return checked.ok ? delivered(body) : checked;
}

// A source update or another accepted decision may alter essential fact conditions. Historical
// derivation checks the new body against the same D5 contract; current admission adds only heads.
function checkFactContracts(store: Store, body: OmInputRecord): OmResult<Sealed<null>> {
  for (const fact of body.input.facts ?? []) {
    const checked = checkAnswerInputBody(store, { project: body.projectId, record: fact.answer,
      question: fact.mc1Question, input: body });
    if (!checked.ok) return checked;
    if (!checked.value.applicable) return refused("answer_inapplicable", "The applied fact no longer matches the exact input contract",
      at(fact.question.id, "answer", fact.answer), "producer");
  }
  return delivered(null);
}

function currentFactGuards(store: Store, body: OmInputRecord): OmResult<Sealed<Ref[]>> {
  const guards: Ref[] = [];
  for (const fact of body.input.facts ?? []) {
    const checked = answerSourceGuards(store, { project: body.projectId, record: fact.answer });
    if (!checked.ok) return checked;
    if (!checked.value.applicable) return refused("answer_inapplicable", "An applied fact's evidence is no longer current",
      at(fact.question.id, "answer", fact.answer), "producer");
    guards.push(...checked.value.guards);
  }
  return delivered(sorted([...new Map(guards.map(ref => [canonical(ref), ref])).values()]));
}

function normalizedInvalidations(value: unknown): AnswerInvalidation[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const answers = new Set<string>(), result: AnswerInvalidation[] = [];
  for (const item of value) {
    if (!object(item) || !isRef(item.record) || answers.has(item.record.id)
      || !Array.isArray(item.sources) || item.sources.length === 0) return null;
    answers.add(item.record.id);
    const sources = new Set<string>();
    for (const source of item.sources) {
      if (!object(source) || !isRef(source.before) || !isRef(source.after) || sources.has(source.before.id)) return null;
      sources.add(source.before.id);
    }
    result.push({ record: item.record, sources: sorted(item.sources) });
  }
  return sorted(result);
}

function normalizedDependencies(value: unknown): ReopenFactDependency[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>(), result: ReopenFactDependency[] = [];
  for (const item of value) {
    if (!object(item) || !isRef(item.record) || !isRef(item.question) || seen.has(item.record.id)
      || !Array.isArray(item.removed) || item.removed.length === 0 || !item.removed.every(isRef)
      || new Set(item.removed.map((ref: Ref) => ref.id)).size !== item.removed.length
      || !Array.isArray(item.conditions) || item.conditions.length === 0
      || !item.conditions.every((condition: unknown) => object(condition) && typeof condition.pointer === "string"
        && Object.hasOwn(condition, "before") && object(condition.after)
        && (condition.after.present === false && !Object.hasOwn(condition.after, "value")
          || condition.after.present === true && Object.hasOwn(condition.after, "value")))) return null;
    seen.add(item.record.id);
    result.push({ record: item.record, question: item.question, removed: sorted(item.removed), conditions: sorted(item.conditions) });
  }
  return sorted(result);
}

/** Historical derivation shared by the addressing writer, restored reads and current admission. */
export function deriveOmInput(store: Store, request: DerivedInputRequest): OmResult<Sealed<OmInputRecord>> {
  return withHistoricalReads(() => deriveOmInputInScope(store, request));
}
function deriveOmInputInScope(store: Store, request: DerivedInputRequest): OmResult<Sealed<OmInputRecord>> {
  if (!object(request)) invalid("request");
  requireInputRequest(store, { project: request.project, stages: {} as InputRequest['stages'], expected: 0 });
  if (!isRef(request.previous)) invalid("previous");
  if ("kind" in request) {
    if (request.kind === "reopen-facts") {
      if (!normalizedInvalidations(request.invalidations)) invalid("invalidations");
      if (Object.hasOwn(request, "dependencies") && !normalizedDependencies(request.dependencies)) invalid("dependencies");
    } else {
      if (request.kind !== "fact") invalid("kind");
      if (!isRef(request.answer)) invalid("answer");
      if (!isRef(request.question)) invalid("question");
    }
  } else {
    if (!isRef(request.graph)) invalid("graph");
    if (!Array.isArray(request.decisions) || !request.decisions.every(isRef)) invalid("decisions");
  }
  request = copy(request);
  const previous = readOmInput(store, request.project, request.previous);
  if (!previous.ok) return previous;
  if ("kind" in request && request.kind === "reopen-facts") {
    const invalidations = normalizedInvalidations(request.invalidations)!;
    const body = previous.value.value, originalFacts = body.input.facts ?? [], removed = new Map<string, AppliedInputFact>();
    for (const invalidation of invalidations) {
      const matching = originalFacts.filter(fact => canonical(fact.answer) === canonical(invalidation.record));
      if (matching.length !== 1 || body.input.questions.some(question => question.id === matching[0]!.question.id))
        return refused("answer_inapplicable", "Invalidation must name one applied fact whose original question is still filled",
          at(request.previous.id, "facts", invalidation.record), "producer");
      const checked = readAnswerInvalidation(store, { project: request.project, invalidation });
      if (!checked.ok) return checked;
      removed.set(canonical(invalidation.record), matching[0]! as AppliedInputFact);
    }
    const provisional = (): OmInputRecord => {
      const input: OmInput = { ...body.input as OmInput,
        questions: sorted([...body.input.questions, ...[...removed.values()].map(fact => fact.question)]) as OmInput['questions'],
        facts: originalFacts.filter(fact => !removed.has(canonical(fact.answer))) as AppliedInputFact[] };
      return { projectId: request.project, input, hash: hashJson(input), gaps: body.gaps as InputGap[] };
    };
    const dependencies: ReopenFactDependency[] = [];
    let result = provisional();
    // Evaluate a whole round against the same withdrawal set. Simultaneous additions and exact
    // condition changes make the fixed point independent of iteration order and replayable later.
    for (;;) {
      const pending: { fact: AppliedInputFact; reason: ReopenFactDependency }[] = [];
      const causes = sorted([...removed.values()].map(fact => fact.answer));
      for (const fact of result.input.facts ?? []) {
        const checked = checkAnswerInputBody(store, { project: request.project, record: fact.answer,
          question: fact.mc1Question, input: result });
        if (!checked.ok) return checked;
        if (checked.value.applicable) continue;
        if (checked.value.requirementChanges.length === 0)
          return refused("answer_inapplicable", "Recovery cannot remove a fact without a changed essential condition",
            at(fact.question.id, "answer", fact.answer), "producer");
        pending.push({ fact, reason: { record: fact.answer, question: fact.mc1Question, removed: causes,
          conditions: sorted(checked.value.requirementChanges) as AnswerRequirementChange[] } });
      }
      if (pending.length === 0) break;
      for (const item of pending) {
        removed.set(canonical(item.fact.answer), item.fact);
        dependencies.push(item.reason);
      }
      result = provisional();
    }
    const normalized = sorted(dependencies);
    if (Object.hasOwn(request, "dependencies")
      && canonical(normalizedDependencies(request.dependencies)) !== canonical(normalized))
      return refused("record_forged", "Dependent recovery causes must follow from the exact prior input and root invalidations",
        at(request.previous.id, "derivation.dependencies", request.previous), "producer");
    result.derivation = { kind: "reopen-facts", previous: request.previous, invalidations,
      ...(normalized.length ? { dependencies: normalized } : {}) };
    const contracts = checkFactContracts(store, result);
    return contracts.ok ? delivered(result) : contracts;
  }
  if ("kind" in request) {
    const checked = readAnswerForInput(store, { project: request.project, record: request.answer,
      question: request.question, input: request.previous, current: false });
    if (!checked.ok) return checked;
    if (!checked.value.applicable) return refused("answer_inapplicable", "The accepted answer does not match this exact input contract",
      at(request.previous.id, "answer", request.answer), "producer");
    const question = checked.value.sourceQuestion as OmInput['questions'][number];
    const fact: AppliedInputFact = { question, value: checked.value.checked.record.value.value as Json,
      answer: request.answer, mc1Question: request.question };
    const body = previous.value.value, existing = body.input.facts?.find(item => item.question.id === question.id);
    if (existing) return canonical(existing) === canonical(fact) ? delivered(body)
      : refused("addressing_conflict", "An applied fact cannot overwrite the already filled question",
        at(question.id, "answer", request.answer), "producer");
    const unresolved = body.input.questions.filter(item => item.id === question.id);
    if (unresolved.length !== 1 || canonical(unresolved[0]) !== canonical(question))
      return refused("answer_inapplicable", "The original question must be an exact unresolved input field",
        at(question.id, "answer", request.answer), "producer");
    const input: OmInput = { ...body.input as OmInput, questions: body.input.questions.filter(item => item.id !== question.id) as OmInput['questions'],
      facts: sorted([...(body.input.facts ?? []), fact]) as AppliedInputFact[] };
    const result: OmInputRecord = { projectId: request.project, input, hash: hashJson(input), gaps: body.gaps as InputGap[],
      derivation: { kind: "fact", previous: request.previous, answer: request.answer, question: request.question } };
    const contracts = checkFactContracts(store, result);
    return contracts.ok ? delivered(result) : contracts;
  }
  const decisions = sorted(request.decisions);
  const derived = deriveInputDecisions(store, { project: request.project, previous: previous.value as Revision<OmInputRecord>,
    graph: request.graph, decisions });
  if (!derived.ok) return derived;
  const result: OmInputRecord = { projectId: request.project, input: derived.value.input as OmInput, hash: hashJson(derived.value.input),
    gaps: derived.value.gaps as InputGap[], derivation: { previous: request.previous, graph: request.graph, decisions: decisions as Ref[] } };
  const contracts = checkFactContracts(store, result);
  return contracts.ok ? delivered(result) : contracts;
}

/** Admit an exact saved version without reconstructing it as a stage-only root or requiring historical heads. */
export function prepareExistingOmInput(store: Store, project: string, ref: Ref): OmResult<Sealed<PreparedOmInput>> {
  return withHistoricalReads(() => prepareExistingOmInputInScope(store, project, ref));
}
function prepareExistingOmInputInScope(store: Store, project: string, ref: Ref): OmResult<Sealed<PreparedOmInput>> {
  const read = readOmInput(store, project, ref);
  if (!read.ok) return read;
  const current = store.get<OmInputRecord>(ref.id);
  if (!current || canonical(reference(current)) !== canonical(ref))
    return refused("input_stale", "The requested OM input version is no longer current", at(ref.id, "head", ref), "producer");
  const body = read.value.value;
  const acceptance = currentAcceptance(store, { project,
    stages: Object.fromEntries(body.input.sources.map(source => [source.stage,
      { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'],
    inventory: body.input.inventory, expected: ref.revision });
  if (!acceptance.ok) return acceptance;
  const facts = currentFactGuards(store, body as OmInputRecord);
  if (!facts.ok) return facts;
  return delivered({ record: body, existing: read.value, writes: [], guards: [...acceptance.value, ...facts.value, ref] });
}

/** The only recovery bypass is the stale fact being removed; stage acceptance remains current. */
export function prepareReopenOmInput(store: Store, request: { project: string; input: Ref }): OmResult<Sealed<PreparedOmInput>> {
  return withHistoricalReads(() => prepareReopenOmInputInScope(store, request));
}
function prepareReopenOmInputInScope(store: Store, request: { project: string; input: Ref }): OmResult<Sealed<PreparedOmInput>> {
  if (!object(request)) invalid("request");
  requireInputRequest(store, { project: request.project, stages: {} as InputRequest['stages'], expected: 0 });
  if (!isRef(request.input)) invalid("input");
  request = copy(request);
  const read = readOmInput(store, request.project, request.input);
  if (!read.ok) return read;
  const current = store.get<OmInputRecord>(request.input.id);
  if (!current) return refused("input_stale", "Recovery requires an existing input head", at(request.input.id, "head", request.input), "producer");
  if (canonical(reference(current)) !== canonical(request.input)) {
    const admitted = prepareExistingOmInput(store, request.project, reference(current));
    if (!admitted.ok) return admitted;
    let cursor = admitted.value.existing as Revision<OmInputRecord>;
    while (cursor.value.derivation) {
      const derivation = cursor.value.derivation;
      if ("kind" in derivation && derivation.kind === "reopen-facts"
        && canonical(derivation.previous) === canonical(request.input))
        return delivered({ record: cursor.value, existing: cursor, writes: [], guards: admitted.value.guards });
      const previous = readOmInput(store, request.project, derivation.previous);
      if (!previous.ok) return previous;
      cursor = previous.value as Revision<OmInputRecord>;
    }
    return refused("input_stale", "An old input can only repeat its exact saved recovery", at(request.input.id, "head", request.input), "producer");
  }
  const body = read.value.value as OmInputRecord;
  const acceptance = currentAcceptance(store, { project: request.project,
    stages: Object.fromEntries(body.input.sources.map(source => [source.stage,
      { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'],
    inventory: body.input.inventory, expected: request.input.revision });
  if (!acceptance.ok) return acceptance;
  const invalidations: AnswerInvalidation[] = [], writes = new Map<string, Write>();
  const guards: Ref[] = [...acceptance.value, request.input];
  for (const fact of body.input.facts ?? []) {
    const prepared = prepareAnswerInvalidation(store, { project: request.project, record: fact.answer });
    if (!prepared.ok) return prepared;
    guards.push(...prepared.value.guards);
    if (prepared.value.invalidation) invalidations.push(prepared.value.invalidation as AnswerInvalidation);
    for (const write of prepared.value.writes) {
      const old = writes.get(write.id);
      if (old && canonical(old) !== canonical(write))
        return refused("input_stale", "A source changed between fact invalidations", at(write.id, "head"), "producer");
      writes.set(write.id, write as Write);
    }
  }
  const pending = new Map([...writes.values()].map(write => [write.id,
    { id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: copy(write.value) }]));
  const view = new Proxy(store, { get(target, property) {
    if (property === "get") return <T = Json>(id: string, revision?: number): Revision<T> | null => {
      const row = pending.get(id);
      return row && (revision === undefined || row.revision === revision) ? row as Revision<T> : target.get<T>(id, revision);
    };
    const member: unknown = Reflect.get(target, property, target);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  // This map is complete before use and never changes. Exact fallback reads are immutable only for a known source.
  const base = sourceView(store);
  if (!isProxy(base) || historicalSnapshots.has(base)) historicalSnapshots.add(view);
  const pendingSource = historicalTrace(view);
  const rebuilt = invalidations.length
    ? deriveOmInput(pendingSource, { project: request.project, kind: "reopen-facts", previous: request.input, invalidations })
    : delivered(body);
  if (!rebuilt.ok) return rebuilt;
  const facts = currentFactGuards(pendingSource, rebuilt.value as OmInputRecord);
  if (!facts.ok) return facts;
  guards.push(...facts.value);
  const heads = new Map<string, Ref>();
  for (const guard of guards) {
    const previous = heads.get(guard.id);
    if (previous && canonical(previous) !== canonical(guard))
      return refused("input_stale", "Recovery observed conflicting source heads", at(guard.id, "head", previous), "producer");
    heads.set(guard.id, guard);
  }
  if (!invalidations.length) return delivered({ record: body, existing: read.value, writes: [], guards: sorted([...heads.values()]) });
  return delivered({ record: rebuilt.value, existing: null,
    writes: [...writes.values(), { id: request.input.id, kind: "om-input", expected: request.input.revision, value: rebuilt.value }],
    guards: sorted([...heads.values()]) });
}

import { isWebDocumentSource } from '../evidence/evidence.js';
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import {
  acceptedIssuance, contractEraAtLeast, contractEraOf, explicitContractEraOf,
  isBasisApplicationEra, isLegacyEra, proveIssuedAnswer, questionMomentRequired,
  requiresMapDesignReconstruction, requirementsForEra,
  UPSTREAM_STAGES, type DiscoveryDraft, type RecordView, type UpstreamStage,
} from "../discovery/projection-reader.js";
import { QUESTION_MOMENTS } from "../discovery/projection-reader.js";
import { conceptApplicationFindings, preparationFindings, specificationApplicationFindings } from "../discovery/preparation-validation.js";
import { discoveryBasisCatalogue } from '../discovery/discovery-outcome.js';
import { buildL1 } from "../graph/builder.js";
import { projectGraph } from "../graph/project.js";
import { isRef, reference, stageId, STAGE_CLOSURE_CONTRACT, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { readLegacyOperation, StageChecks } from "../product/stage-checks.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { historicalProof, historicalTrace, pendingSnapshotView, withHistoricalReads } from "../history/proofs.js";
import { uniqueTransactionGuards, transactionGuardsCurrent } from "../runtime/environment.js";
import { delivered, isPlainObject, localErrors, localRefusals, sealed, transfer, type OmResult, type Refusal, type Sealed, type SourceCodes } from "./refusal.js";
import { readRecord, writeGuarded } from "./refs.js";
import { preparationMatches } from "./selected-specification.js";
import type { Graph } from "../graph/model.js";
import { transitionField } from "./impact.js";
import { deriveInputDecisions } from "./addressing.js";
import { answerSourceGuards, checkAnswerInputBody, prepareAnswerInvalidation, readAnswerForInput,
  readAnswerInvalidation, type AnswerInvalidation, type AnswerRequirementChange } from "./accepted-answer.js";

// R5 (№2451): the common mechanism of historical reads lives in history/proofs; its former entries stay here as re-exports.
export { historicalProof, historicalRead, historicalTrace, withHistoricalReads, type HistoricalReadKey } from "../history/proofs.js";

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
/**
 * Q2 (№2452-5, №2460): every code input.ts creates itself. The builder/gate subset above stays the exact set older
 * tests pin; the local constructor below accepts this whole catalogue and nothing else.
 */
export const INPUT_LOCAL_CODES = Object.freeze([...INPUT_REFUSAL_CODES,
  "om_admission_guard_invalid", "om_admission_guard_unsupported", "input_stale", "legacy_operation_active",
  "record_forged", "answer_inapplicable", "addressing_conflict", "input_refresh_conflict"] as const);
export type InputLocalCode = typeof INPUT_LOCAL_CODES[number];
/** The exceptions input.ts throws itself (requests, admission channels, acceptance proofs, a moved dependency). */
export const INPUT_ERROR_CODES = Object.freeze(["input_request_invalid", "om_admission_guard_invalid", "stage_not_accepted", "input_stale"] as const);
export type InputErrorCode = typeof INPUT_ERROR_CODES[number];
/** The units whose refusals input.ts hands on unchanged, each through a declared transfer. */
export type InputSource = "refs" | "addressing" | "accepted-answer";
export type InputCode = InputLocalCode | SourceCodes<InputSource>;
export type InputResult<T> = OmResult<T, InputCode>;
const refuse = localRefusals(INPUT_LOCAL_CODES);
// Annotated explicitly: only a declared `never` makes a bare call end the control flow for tsc.
const raise: (code: InputErrorCode, message: string, details?: unknown) => never = localErrors(INPUT_ERROR_CODES);
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
    moment?: typeof QUESTION_MOMENTS[number]; addressedBy?: Ref; originalConsumer?: string; readiness?: ReadinessCause }[];
  facts?: AppliedInputFact[];
  /** OWN1 (№3711): predecessor questions the model decided in the bypass, each with its F5.3 decision; no longer asked. */
  decided?: DecidedInputQuestion[];
  map: { nodes: string[]; artifacts: string[]; connectors: string[] };
}
export interface DecidedInputQuestion { question: OmInput['questions'][number]; value: Json; decision: Ref }
export interface AppliedInputFact { question: OmInput['questions'][number]; value: Json; answer: Ref; mc1Question: Ref }
/**
 * AT1 (№4105): the exact cause of a readiness question, from the saved G5 finding that named it. A transition is the
 * expression at one address of one snapshot; its accepted answer resolves it as {answer, resolves}. The cause is the
 * question's identity: the same cause asks once, and a changed snapshot or expression is a new question.
 */
export const READINESS_CONTRACT = 'om-readiness/v1' as const;
export interface ReadinessTransition { contract: typeof READINESS_CONTRACT; cause: 'transition'; snapshot: { commit: string; tree: string };
  file: string; line: number; kind: string; expression: string; site: { start: number; end: number; hash: string }; candidates: string[]; works: string[];
  /** Return №4197: the accepted place of each block its works stand in — the one question is a gap of every one of them. */
  places: string[] }
/**
 * AT1 (№4117, contract §1.3, return №4124 P2-1): the policy of a shared durable contract — how its state appears, or how
 * its provider is called — decided once for that exact contract (`governs`: the result contract and the hash of its schema)
 * at its producer (the node the works' boundary names), whom the consumer works of the same contract refer to. Another
 * contract of the same producer is another policy. `producer` is that node, or the name the boundary gives when no
 * accepted node bears it (the question is then asked above the works).
 */
export interface ReadinessPolicy { contract: typeof READINESS_CONTRACT; cause: 'policy'; policy: 'appearance' | 'provider'; producer: string;
  governs: { contract: string; hash: string }; works: string[] }
export type ReadinessCause = ReadinessTransition | ReadinessPolicy;
/**
 * The question's identity: the exact cause and the place it is asked for — for a transition its snapshot, address and
 * expression; for a policy its kind and producer.
 */
// Return №4186 P1: a transition is one question of its snapshot — whichever works and blocks need it, one answer serves them all.
export const readinessQuestionId = (cause: ReadinessCause, consumer: string): string => cause.cause === 'transition'
  ? `readiness:transition:${hashJson([cause.snapshot.tree, cause.file, cause.site.start, cause.site.end, cause.site.hash])}`
  : `readiness:policy:${hashJson([cause.policy, cause.producer, cause.governs.contract, cause.governs.hash, consumer])}`;
export interface InputBuildResult { input: OmInput | null; hash: string | null; refusals: Refusal[]; gaps: InputGap[] }
/**
 * What the builder itself returns: the same shape with its refusals REPLACED (not intersected, №2511-2) by the builder's own
 * catalogue — an intersection would keep the wide list's overloads, and a refusal of another unit could be pushed into it.
 */
export interface BuiltOmInput extends Omit<InputBuildResult, "refusals"> { readonly refusals: Refusal<InputRefusalCode>[] }
export interface InputRequest { project: string; stages: Record<UpstreamStage, Ref>; inventory?: Ref | null; expected: number }
export interface DecisionInputDerivation { previous: Ref; graph: Ref; decisions: Ref[] }
export interface RefreshInputDerivation { kind: "refresh"; previous: Ref; stages: Record<UpstreamStage, Ref>; inventory: Ref | null }
export interface FactInputDerivation { kind: "fact"; previous: Ref; answer: Ref; question: Ref }
export interface ReopenFactDependency { record: Ref; question: Ref; removed: Ref[]; conditions: AnswerRequirementChange[] }
/** AT1 door (№4105): the readiness questions of one saved G5 rejection of the impact era, asked on the B1 of its own chain. */
export interface ReadinessInputDerivation { kind: "readiness"; previous: Ref; gate: Ref }
export interface ReopenFactInputDerivation { kind: "reopen-facts"; previous: Ref; invalidations: AnswerInvalidation[];
  dependencies?: ReopenFactDependency[] }
export type InputDerivation = DecisionInputDerivation | RefreshInputDerivation | FactInputDerivation | ReopenFactInputDerivation | ReadinessInputDerivation;
export interface OmInputRecord { projectId: string; input: OmInput; hash: string; gaps: InputGap[]; derivation?: InputDerivation }
export type DerivedInputRequest = { project: string } & (DecisionInputDerivation | FactInputDerivation | ReopenFactInputDerivation | ReadinessInputDerivation);
export interface PreparedOmInput<G extends TransactionGuard = TransactionGuard> { record: OmInputRecord; writes: Write[]; guards: G[]; existing: Revision<OmInputRecord> | null }
export const INPUT_REFRESH_CONFLICT = "input_refresh_conflict";

type Row = Record<string, any>;
const object = (value: unknown): value is Row => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]): T[] => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const at = (target: string, field: string, ref?: Ref) => ({ unit: "G1", target, field, ...(ref ? { ref } : {}) });
function invalid(field: string): never { return raise("input_request_invalid", "OM input needs a well-formed request", at("om-input", field)); }
function copy<T>(value: T): T {
  try { return sealed(value) as T; } catch { return invalid("json"); }
}

/** Validate the complete admission channel before selecting its producer era. */
function readTransactionAdmission(value: unknown, gate: string, unit: "G1" | "G2" | "F4"): InputResult<Sealed<TransactionGuard[]>> {
  if (!text(gate) || !["G1", "G2", "F4"].includes(unit))
    raise("om_admission_guard_invalid", "An admission channel needs its named gate and unit",
      { unit: "OM", target: "admissionGuards", field: !text(gate) ? "gate" : "unit" });
  let checked: TransactionGuard[];
  try { checked = uniqueTransactionGuards(value === undefined ? [] : value as TransactionGuard[]); }
  catch (error) {
    if (error instanceof EngineError && error.code === "invalid_guard")
      return refuse("om_admission_guard_invalid", `${gate}: ${error.message}`,
        { unit, target: gate, field: "admissionGuards" }, "producer");
    throw error;
  }
  return delivered(checked);
}

/** Legacy producers support positive refs only; stage-closure/v1 carries full guards. */
export function readOmAdmissionGuards(value: unknown, gate: string, unit: "G1" | "G2" | "F4"): InputResult<Sealed<Ref[]>> {
  const checked = readTransactionAdmission(value, gate, unit);
  if (!checked.ok) return checked;
  const refs: Ref[] = [];
  for (const guard of checked.value) {
    if ('absent' in guard)
      return refuse("om_admission_guard_unsupported", `${gate} declares an absence not supported by this OM producer`,
        { unit, target: guard.id, field: `${gate}.admissionGuards` }, "producer");
    refs.push(guard);
  }
  return delivered(refs);
}

/** Pure normalization; persistence independently resolves and checks the saved source records. */
export function buildOmInput(stages: InputStages, options: InputOptions = {}): Sealed<BuiltOmInput> {
  if (!object(stages)) invalid("stages");
  if (!object(options) || (options.inventory !== undefined && options.inventory !== null && !isRef(options.inventory))
    || (options.nodesRequiredSince !== undefined && options.nodesRequiredSince !== null
      && (!Number.isSafeInteger(options.nodesRequiredSince) || options.nodesRequiredSince <= 0))) invalid("options");
  options = copy(options);
  const refusals: Refusal<InputRefusalCode>[] = [], gaps: InputGap[] = [];
  const fail = (code: InputRefusalCode, stage: UpstreamStage, field: string, message: string) => {
    const ref = stages[stage]?.ref;
    const result = refuse(code, message, at(isRef(ref) ? ref.id : `stage:${stage}`, field, isRef(ref) ? ref : undefined), "producer");
    if (!result.ok) refusals.push(result.refusal);
  };
  for (const stage of INPUT_STAGES) {
    const value = stages[stage];
    if (!object(value) || !isRef(value.ref) || !object(value.fields)) fail("input_field_missing", stage, "source", "A stage needs exact source and fields");
    else if (value.contractVersion !== null && (!Number.isSafeInteger(value.contractVersion) || value.contractVersion <= 0))
      fail("stage_contract_version_unknown", stage, "contractVersion", "The exact draft contract version is unavailable");
  }
  const finish = (input: OmInput | null): Sealed<BuiltOmInput> => sealed({ input: refusals.length ? null : input,
    hash: refusals.length || !input ? null : hashJson(input), refusals: sorted(refusals), gaps: sorted(gaps) });
  if (refusals.length) return finish(null);
  // Check the new mandatory field before JSON normalization, including explicit undefined.
  for (const stage of ["discovery", "features"] as const) {
    if (!questionMomentRequired(stages[stage].contractVersion)) continue;
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
    return threshold !== null && contractEraAtLeast(version, threshold);
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
  // SP1 (№4714 §3): the one matching rule the delivery of the full preparation shares; B1 keeps its own gap/refusal handling.
  const prepOf = (feature: Row): Row[] => preparationMatches(preps, feature).map(match => match.value as Row);
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
      ...(questionMomentRequired(stages[stage].contractVersion) ? { moment: raw.moment } : {}) });
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

/** Version-only historical lookup; exact B1 proof questions select their known edition below. */
export function inputResearchRequirements(version: number | null | undefined) {
  return requirementsForEra(version);
}

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
function loadSources(store: Store, request: InputRequest): InputResult<Sealed<InputStages>> {
  const stages = new Map<UpstreamStage, Revision<StageArtifact>>();
  for (const stage of INPUT_STAGES) {
    const result = readRecord<StageArtifact>(store, request.stages[stage], { unit: "G1", target: stageId(request.project, stage),
      id: stageId(request.project, stage), kind: "stage" });
    if (!result.ok) return transfer("refs", result);
    stages.set(stage, result.value as Revision<StageArtifact>);
  }
  const sources: Partial<InputStages> = {};
  for (const [index, stage] of INPUT_STAGES.entries()) {
    const record = stages.get(stage)!;
    const bad = (field: string, message: string): never => {
      raise("stage_not_accepted", message, at(record.id, field, reference(record)));
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
      const eraInfo = explicitContractEraOf(draft);
      const version = eraInfo.present ? eraInfo.version : null;
      check(version === null || typeof version === "number" && Number.isSafeInteger(version) && version > 0, "contractVersion", "The exact draft version is malformed");
      check(inputResearchRequirements(version), "contractVersion", "The draft uses an unknown historical contract");
      check(Array.isArray(draft.questions) && draft.questions.every(text) && Array.isArray(draft.inputs) && draft.inputs.every(isRef),
        "content.draft", "The research question and input sets must be explicit");
      for (const input of draft.inputs) proof(input);
      check(!predecessor || draft.inputs.some((ref: Ref) => canonical(ref) === canonical(reference(predecessor))), "inputs", "Research must bind its accepted predecessor");
      const questionView: RecordView = { get: (id: string) => byId(id, "question") as Revision<never> };
      const issuance = acceptedIssuance(questionView, draftRecord as Revision<DiscoveryDraft>);
      check(issuance.issued, "questions", issuance.issued ? ""
        : issuance.failure === "contract" ? "The complete question set must match the saved contract era"
        : "Every research question must have its own saved answer");
      const observation = (raw: unknown): Json => {
        check(object(raw) && raw.projectId === request.project && isRef(raw.source) && object(raw.selector), "observation", "Observation needs its project, exact source and selector");
        const sourceRecord = proof(raw.source, "source"), source = sourceRecord.value;
        check(sourceRecord.id.startsWith(`source:${request.project}:`) && source.projectId === request.project
          && typeof source.content === "string" && digest(source.content) === source.sha256
          && (["text/plain", "application/json"].includes(source.mediaType) || isWebDocumentSource(source)) && object(source.origin)
          && ["file", "owner-document", "web"].includes(source.origin.kind) && typeof source.origin.location === "string",
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
      for (const entry of issuance.entries) {
        check(!entry.foreign && entry.staged && entry.namespaced && entry.answered,
          "questions", "Every research question must have its own saved answer");
        const answerRecord = proof(entry.answerRef!);
        // Прежний приоритет: пространство имён и вид записи проверяются до
        // читателя цепочки принятия внутри proveIssuedAnswer.
        check(answerRecord.id.startsWith(`${answerRecord.kind}:${request.project}:`)
          && (answerRecord.kind === entry.specKind || answerRecord.kind === "research-answer"),
          "answers", "The answer belongs to another question, project or kind");
        // D8.4.2 (№2230): provenance through the common reader inside the boundary — a managed
        // answer proves its own turn's K (the transitive reads join this B1 trail through the
        // traced store); the exact K must already sit in the stage's saved proofs (it lands
        // there from gate's guards).
        const issued = proveIssuedAnswer(store, draftRecord as Revision<DiscoveryDraft>, entry, answerRecord,
          { verifyIssuedQuestion: true });
        check(issued.ok, "answers", "The answer belongs to another question, project or kind");
        const proven = issued.proof, prov = proven.provenance;
        if (prov.kind === "fact") observation(prov.observation);
        else if (prov.kind === "research-answer") {
          if (prov.binding) proof(reference(prov.binding), "research-acceptance-binding");
          proof(prov.assessmentRef!, "research-assessment");
          check(prov.wellFormed && prov.independent && prov.supported, "assessment", "Research needs an independent supported assessment");
          check(prov.bindsQuestion === true, "assessment.question", "Assessment must bind the issued question contract");
          check(prov.hasObservations, "assessment.observations", "Supported research needs saved observations");
          for (const raw of prov.observations) observation(raw);
          for (const dependency of prov.runtimeDependencies) proof(dependency);
          check(prov.valueMatches, "assessment.value", "The assessment must support this answer value");
        } else check(prov.hasAuthor, "answer.actor", "A saved decision names its owner");
        check(proven.reproduces, `fields.${entry.field}`, "Fields must match the answered value and historical schema");
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
        if (requiresMapDesignReconstruction(version)) {
          const initial = sources.discovery!.fields, concept = sources.concept!.fields;
          const proposed = buildL1(projection.id, projection.title, content.fields.mapDesign, initial, concept);
          check(canonical(projectGraph(proposed, 1)) === canonical(projection), "content.graph", "The exact map must derive from its saved stage fields");
        }
      } else check(content.graph === null, "content.graph", "Only the operation map binds its own L1 projection");
      sources[stage] = { ref: reference(record), contractVersion: version ?? null, fields: content.fields as Record<string, Json> };
    } catch (error) {
      return refuse("stage_not_accepted", error instanceof Error ? error.message : "Saved acceptance proof is invalid",
        error instanceof EngineError && error.code === "stage_not_accepted" ? error.details as ReturnType<typeof at>
          : at(record.id, "proofs", reference(record)), "producer");
    }
  }
  const result = sources as InputStages;
  const behaviors = result.specification.fields['behavior'], features = result.features.fields['features'];
  if (Array.isArray(behaviors) && Array.isArray(features)) {
    const covered = new Set(features.flatMap((feature: unknown) => object(feature) && Array.isArray(feature.requirements) ? feature.requirements : []));
    if (covered.size !== behaviors.length || [...covered].some(value => !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= behaviors.length))
      return refuse("stage_not_accepted", "Prepared features must cover every specified behavior", at(result.features.ref.id, "features.requirements", result.features.ref), "producer");
  }
  if (isBasisApplicationEra(result.concept.contractVersion)) {
    try {
      const catalogue = discoveryBasisCatalogue({ ref: result.discovery.ref, fields: result.discovery.fields });
      const applications = conceptApplicationFindings(result.concept.fields['conceptSections'] ?? null, catalogue);
      if (applications.length) return refuse('stage_not_accepted',
        `${applications[0]!.code}: ${applications[0]!.message}`,
        at(result.concept.ref.id, applications[0]!.target.slice(1), result.concept.ref), 'producer');
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return refuse('stage_not_accepted', `${error.code}: ${error.message}`,
        at(result.discovery.ref.id, 'content.fields', result.discovery.ref), 'producer');
    }
  }
  if (isBasisApplicationEra(result.specification.contractVersion)) {
    try {
      const catalogue = discoveryBasisCatalogue({ ref: result.discovery.ref, fields: result.discovery.fields });
      const applications = specificationApplicationFindings(result.specification.fields['behaviorContracts'] ?? null,
        result.concept.fields['conceptSections'] ?? null, catalogue);
      if (applications.length) return refuse('stage_not_accepted',
        `${applications[0]!.code}: ${applications[0]!.message}`,
        at(result.specification.ref.id, applications[0]!.target.slice(1), result.specification.ref), 'producer');
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return refuse('stage_not_accepted', `${error.code}: ${error.message}`,
        at(result.discovery.ref.id, 'content.fields', result.discovery.ref), 'producer');
    }
  }
  const outcomes = (result['operation-map'].fields['mapDesign'] as Row)?.artifacts;
  if (Array.isArray(outcomes)) for (const stage of INPUT_STAGES) {
    if (isLegacyEra(contractEraOf(result[stage]))) continue;
    const findings = preparationFindings(stage, result[stage].fields, name => result[name as UpstreamStage]?.fields ?? null,
      outcomes.map((artifact: Row) => artifact.id));
    if (findings.length) return refuse("stage_not_accepted", findings[0]!.message,
      at(result[stage].ref.id, findings[0]!.field ?? findings[0]!.target, result[stage].ref), "producer");
  }
  return delivered(result);
}

function deriveInputRecord(store: Store, request: InputRequest): InputResult<Sealed<OmInputRecord>> {
  const sources = loadSources(store, request);
  if (!sources.ok) return sources;
  const inventory = request.inventory ?? null;
  if (inventory) {
    const read = readRecord(store, inventory, { unit: "G1", target: inventory.id, id: `repo-inventory:${request.project}`, kind: "repo-inventory" });
    if (!read.ok) return transfer("refs", read);
  }
  const result = buildOmInput(sources.value as InputStages, { inventory });
  if (result.refusals.length) return { ok: false, refusal: result.refusals[0]! };
  if (!result.input || !result.hash) invalid("result");
  return delivered({ projectId: request.project, input: result.input as OmInput, hash: result.hash, gaps: result.gaps as InputGap[] });
}

function sourcesMatch(input: { readonly sources?: readonly { readonly stage: string; readonly id: string; readonly revision: number; readonly hash: string }[]; readonly inventory?: Ref | null }, stages: InputRequest['stages'], inventory?: Ref | null): boolean {
  if (!Array.isArray(input.sources) || input.sources.length !== INPUT_STAGES.length) return false;
  for (const source of input.sources) {
    const reqStage = stages[source.stage as UpstreamStage];
    if (!reqStage || reqStage.id !== source.id || reqStage.revision !== source.revision || reqStage.hash !== source.hash) {
      return false;
    }
  }
  const currentInv = input.inventory ?? null;
  const requestedInv = inventory ?? null;
  if (currentInv === null && requestedInv === null) return true;
  if (currentInv === null || requestedInv === null) return false;
  return canonical(currentInv) === canonical(requestedInv);
}

// Current acceptance reads more heads than Pipeline exposes as guards (notably the full graph).
// Check requested stages via batch headsMatch/transactionGuardsCurrent, read graph head explicitly, inspect pipeline features, and return deduplicated TransactionGuards.
function currentAcceptance(store: Store, request: InputRequest): InputResult<Sealed<TransactionGuard[]>> {
  const requestedSources: Ref[] = [
    ...INPUT_STAGES.map(stage => request.stages[stage]),
    ...(request.inventory ? [request.inventory] : []),
  ];
  if (!transactionGuardsCurrent(store, requestedSources)) {
    for (const ref of requestedSources) {
      const head = store.get(ref.id);
      if (!head || canonical(reference(head)) !== canonical(ref))
        return refuse("input_stale", "The requested input source is no longer current", at(ref.id, "head", ref), "producer");
    }
    return refuse("input_stale", "The requested input source is no longer current", at(requestedSources[0]!.id, "head", requestedSources[0]), "producer");
  }

  try {
    // Explicit head read for graph:<project> (required for CAS guard & propagating corrupt errors)
    const graphRecord = store.get(`graph:${request.project}`);
    const graphGuard: Ref | null = graphRecord ? reference(graphRecord) : null;

    const projection = new StageChecks(store).pipeline.inspect(request.project, "features");
    const admission = projection.artifact?.value.closure?.contract === STAGE_CLOSURE_CONTRACT
      ? readTransactionAdmission(projection.admissionGuards, "pipeline.features", "G1")
      : readOmAdmissionGuards(projection.admissionGuards, "pipeline.features", "G1");
    if (!admission.ok) return admission;
    if (projection.state !== "accepted") {
      const finding = projection.findings[0];
      return refuse("stage_not_accepted", finding?.message ?? "The current stages are not accepted",
        at(finding?.target ?? request.stages.features.id, finding?.field ?? finding?.code ?? "status", request.stages.features), "producer");
    }

    const allGuards: TransactionGuard[] = [
      ...requestedSources,
      ...(graphGuard ? [graphGuard] : []),
      ...projection.guards,
      ...admission.value,
    ];

    return delivered(uniqueTransactionGuards(allGuards));
  } catch (error) {
    if (error instanceof EngineError && error.code === "input_stale")
      return refuse("input_stale", error.message, error.details as ReturnType<typeof at>, "producer");
    throw error;
  }
}

export function prepareOmInput(store: Store, request: InputRequest): InputResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  return prepareOmInputInScope(store, request);
}
function prepareOmInputInScope(store: Store, request: InputRequest): InputResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  requireInputRequest(store, request);
  request = copy(request);
  const id = `om-input:${request.project}`, current = store.get<OmInputRecord>(id);
  const initialGuards: TransactionGuard[] = [];
  if (!current) {
    const operation = readLegacyOperation(store, request.project);
    if (operation?.value.state === "active")
      return refuse("legacy_operation_active", "The first OM input requires the legacy operation to finish",
        at(operation.id, "state", reference(operation)), "producer");
    initialGuards.push(operation ? reference(operation) : { id: `legacy-operation:${request.project}`, absent: true });
  }

  const checked = current && current.revision === request.expected
    ? readOmInput(store, request.project, reference(current)) : null;
  if (checked && !checked.ok) return checked;

  // Quick-path when the current input's stage sources and inventory already match the request.
  // This avoids re-deriving the input record and loading/decoding all upstream stage proofs.
  if (current && checked?.ok && sourcesMatch(checked.value.value.input, request.stages, request.inventory)) {
    if (Object.hasOwn(checked.value.value, "derivation")) {
      return prepareExistingOmInput(store, request.project, reference(current));
    }
    const acceptance = currentAcceptance(store, request);
    if (!acceptance.ok) return acceptance;
    return delivered({
      record: checked.value.value,
      existing: current,
      writes: [],
      guards: uniqueTransactionGuards([...acceptance.value, reference(current), ...initialGuards]),
    });
  }

  const derived = withHistoricalReads(() => deriveInputRecord(store, request));
  if (!derived.ok) return derived;

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
      guards: uniqueTransactionGuards([...acceptance.value, ...facts.value, reference(current)]) });
  }
  const acceptance = currentAcceptance(store, request);
  if (!acceptance.ok) return acceptance;
  const record = derived.value;
  const guards = [...acceptance.value];
  const existing = current?.kind === "om-input" && current.revision === request.expected && canonical(current.value) === canonical(record) ? current : null;
  return delivered({ record, existing, writes: existing ? [] : [{ id, kind: "om-input", expected: request.expected, value: record }],
    guards: uniqueTransactionGuards([...guards, ...(existing ? [reference(existing)] : []), ...initialGuards]) });
}

export function writeOmInput(store: Store, request: InputRequest): InputResult<Sealed<Revision<OmInputRecord>>> {
  return writeOmInputInScope(store, request);
}
function writeOmInputInScope(store: Store, request: InputRequest): InputResult<Sealed<Revision<OmInputRecord>>> {
  const prepared = prepareOmInput(store, request);
  if (!prepared.ok) return prepared;
  if (prepared.value.existing) return delivered(prepared.value.existing);
  const result = writeGuarded<OmInputRecord>(store, { unit: "G1", target: `om-input:${request.project}`,
    writes: prepared.value.writes as Write[], guards: prepared.value.guards });
  if (!result.ok) return transfer("refs", result);
  return delivered(result.value[0]!);
}

export function readOmInput(store: Store, project: string, ref: Ref): InputResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    requireInputRequest(store, { project, stages: {} as InputRequest['stages'], expected: 0 });
    if (!isRef(ref)) return readInputRecord(store, project, ref);
    return historicalProof(store, { reader: "B1.readOmInput", project, ref }, source => readInputRecord(source, project, ref),
      () => refuse("record_forged", "Input sources contain a cyclic derivation", at(ref.id, "derivation", ref), "producer"), value => value.ok);
  });
}

/** NR1 (№3600): a trusted read. Every input revision was derived by prepareOmInput / deriveOmInput from its exact sources
 * and predecessor (a refresh carries accepted decisions, never erases them) and written under its guards; it is read at its
 * exact reference, never rebuilt. */
function readInputRecord(store: Store, project: string, ref: Ref): InputResult<Sealed<Revision<OmInputRecord>>> {
  requireInputRequest(store, { project, stages: {} as InputRequest['stages'], expected: 0 });
  const read = readRecord<OmInputRecord>(store, ref, { unit: "G1", target: `om-input:${project}`, id: `om-input:${project}`, kind: "om-input" });
  return read.ok ? delivered(read.value) : transfer("refs", read);
}

// Both arguments have passed their source-derived historical readers. Inventory is the only independent
// root source here: a stage change needs a separate resolution, never an implicit reset of D3 fields.
function refreshInputRecord(store: Store, previous: Revision<OmInputRecord>, root: OmInputRecord): InputResult<Sealed<OmInputRecord>> {
  if (canonical(previous.value.input.sources) !== canonical(root.input.sources))
    return refuse(INPUT_REFRESH_CONFLICT, "Changed stage sources require an explicit resolution of the accepted input decisions",
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
function checkFactContracts(store: Store, body: OmInputRecord): InputResult<Sealed<null>> {
  for (const fact of body.input.facts ?? []) {
    const checked = checkAnswerInputBody(store, { project: body.projectId, record: fact.answer,
      question: fact.mc1Question, input: body });
    if (!checked.ok) return transfer("accepted-answer", checked);
    if (!checked.value.applicable) return refuse("answer_inapplicable", "The applied fact no longer matches the exact input contract",
      at(fact.question.id, "answer", fact.answer), "producer");
  }
  return delivered(null);
}

function currentFactGuards(store: Store, body: OmInputRecord): InputResult<Sealed<Ref[]>> {
  const guards: Ref[] = [];
  for (const fact of body.input.facts ?? []) {
    const checked = answerSourceGuards(store, { project: body.projectId, record: fact.answer });
    if (!checked.ok) return transfer("accepted-answer", checked);
    if (!checked.value.applicable) return refuse("answer_inapplicable", "An applied fact's evidence is no longer current",
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
export function deriveOmInput(store: Store, request: DerivedInputRequest): InputResult<Sealed<OmInputRecord>> {
  return withHistoricalReads(() => deriveOmInputInScope(store, request));
}
function deriveOmInputInScope(store: Store, request: DerivedInputRequest): InputResult<Sealed<OmInputRecord>> {
  if (!object(request)) invalid("request");
  requireInputRequest(store, { project: request.project, stages: {} as InputRequest['stages'], expected: 0 });
  if (!isRef(request.previous)) invalid("previous");
  if ("kind" in request) {
    if (request.kind === "reopen-facts") {
      if (!normalizedInvalidations(request.invalidations)) invalid("invalidations");
      if (Object.hasOwn(request, "dependencies") && !normalizedDependencies(request.dependencies)) invalid("dependencies");
    } else if (request.kind === "readiness") {
      if (!isRef(request.gate) || Object.keys(request).some(key => !["project", "kind", "previous", "gate"].includes(key))) invalid("gate");
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
        return refuse("answer_inapplicable", "Invalidation must name one applied fact whose original question is still filled",
          at(request.previous.id, "facts", invalidation.record), "producer");
      const checked = readAnswerInvalidation(store, { project: request.project, invalidation });
      if (!checked.ok) return transfer("accepted-answer", checked);
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
        if (!checked.ok) return transfer("accepted-answer", checked);
        if (checked.value.applicable) continue;
        if (checked.value.requirementChanges.length === 0)
          return refuse("answer_inapplicable", "Recovery cannot remove a fact without a changed essential condition",
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
      return refuse("record_forged", "Dependent recovery causes must follow from the exact prior input and root invalidations",
        at(request.previous.id, "derivation.dependencies", request.previous), "producer");
    result.derivation = { kind: "reopen-facts", previous: request.previous, invalidations,
      ...(normalized.length ? { dependencies: normalized } : {}) };
    const contracts = checkFactContracts(store, result);
    return contracts.ok ? delivered(result) : contracts;
  }
  if ("kind" in request && request.kind === "readiness") {
    const body = previous.value.value as OmInputRecord;
    const asked = readinessQuestions(store, request.project, previous.value as Revision<OmInputRecord>, request.gate);
    if (!asked.ok) return asked;
    // Nothing new to ask — every cause is open, applied or decided already: the same B1, no new revision (a repeat).
    if (!asked.value.length) return delivered(body);
    const input: OmInput = { ...body.input as OmInput, questions: sorted([...body.input.questions, ...asked.value]) as OmInput['questions'] };
    return delivered({ projectId: request.project, input, hash: hashJson(input), gaps: body.gaps as InputGap[],
      derivation: { kind: "readiness", previous: request.previous, gate: request.gate } });
  }
  if ("kind" in request) {
    const checked = readAnswerForInput(store, { project: request.project, record: request.answer,
      question: request.question, input: request.previous, current: false });
    if (!checked.ok) return transfer("accepted-answer", checked);
    if (!checked.value.applicable) return refuse("answer_inapplicable", "The accepted answer does not match this exact input contract",
      at(request.previous.id, "answer", request.answer), "producer");
    const question = checked.value.sourceQuestion as OmInput['questions'][number];
    const fact: AppliedInputFact = { question, value: checked.value.checked.record.value.value as Json,
      answer: request.answer, mc1Question: request.question };
    const body = previous.value.value, existing = body.input.facts?.find(item => item.question.id === question.id);
    if (existing) return canonical(existing) === canonical(fact) ? delivered(body)
      : refuse("addressing_conflict", "An applied fact cannot overwrite the already filled question",
        at(question.id, "answer", request.answer), "producer");
    const unresolved = body.input.questions.filter(item => item.id === question.id);
    if (unresolved.length !== 1 || canonical(unresolved[0]) !== canonical(question))
      return refuse("answer_inapplicable", "The original question must be an exact unresolved input field",
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
  if (!derived.ok) return transfer("addressing", derived);
  const result: OmInputRecord = { projectId: request.project, input: derived.value.input as OmInput, hash: hashJson(derived.value.input),
    gaps: derived.value.gaps as InputGap[], derivation: { previous: request.previous, graph: request.graph, decisions: decisions as Ref[] } };
  const contracts = checkFactContracts(store, result);
  return contracts.ok ? delivered(result) : contracts;
}

/** Admit an exact saved version without reconstructing it as a stage-only root or requiring historical heads. */
export function prepareExistingOmInput(store: Store, project: string, ref: Ref): InputResult<Sealed<PreparedOmInput>> {
  return prepareExistingOmInputInScope(store, project, ref);
}
function prepareExistingOmInputInScope(store: Store, project: string, ref: Ref): InputResult<Sealed<PreparedOmInput>> {
  const read = readOmInput(store, project, ref);
  if (!read.ok) return read;
  const current = store.get<OmInputRecord>(ref.id);
  if (!current || canonical(reference(current)) !== canonical(ref))
    return refuse("input_stale", "The requested OM input version is no longer current", at(ref.id, "head", ref), "producer");
  const body = read.value.value;
  const acceptance = currentAcceptance(store, { project,
    stages: Object.fromEntries(body.input.sources.map(source => [source.stage,
      { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'],
    inventory: body.input.inventory, expected: ref.revision });
  if (!acceptance.ok) return acceptance;
  const facts = currentFactGuards(store, body as OmInputRecord);
  if (!facts.ok) return facts;
  return delivered({ record: body, existing: read.value, writes: [], guards: sorted([...new Map([...acceptance.value, ...facts.value, ref].map(r => [canonical(r), r])).values()]) });
}

/** The only recovery bypass is the stale fact being removed; stage acceptance remains current. */
export function prepareReopenOmInput(store: Store, request: { project: string; input: Ref }): InputResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  return withHistoricalReads(() => prepareReopenOmInputInScope(store, request));
}
function prepareReopenOmInputInScope(store: Store, request: { project: string; input: Ref }): InputResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  if (!object(request)) invalid("request");
  requireInputRequest(store, { project: request.project, stages: {} as InputRequest['stages'], expected: 0 });
  if (!isRef(request.input)) invalid("input");
  request = copy(request);
  const read = readOmInput(store, request.project, request.input);
  if (!read.ok) return read;
  const current = store.get<OmInputRecord>(request.input.id);
  if (!current) return refuse("input_stale", "Recovery requires an existing input head", at(request.input.id, "head", request.input), "producer");
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
    return refuse("input_stale", "An old input can only repeat its exact saved recovery", at(request.input.id, "head", request.input), "producer");
  }
  const body = read.value.value as OmInputRecord;
  const acceptance = currentAcceptance(store, { project: request.project,
    stages: Object.fromEntries(body.input.sources.map(source => [source.stage,
      { id: source.id, revision: source.revision, hash: source.hash }])) as InputRequest['stages'],
    inventory: body.input.inventory, expected: request.input.revision });
  if (!acceptance.ok) return acceptance;
  const invalidations: AnswerInvalidation[] = [], writes = new Map<string, Write>();
  const guards: TransactionGuard[] = [...acceptance.value, request.input];
  for (const fact of body.input.facts ?? []) {
    const prepared = prepareAnswerInvalidation(store, { project: request.project, record: fact.answer });
    if (!prepared.ok) return transfer("accepted-answer", prepared);
    guards.push(...prepared.value.guards);
    if (prepared.value.invalidation) invalidations.push(prepared.value.invalidation as AnswerInvalidation);
    for (const write of prepared.value.writes) {
      const old = writes.get(write.id);
      if (old && canonical(old) !== canonical(write))
        return refuse("input_stale", "A source changed between fact invalidations", at(write.id, "head"), "producer");
      writes.set(write.id, write as Write);
    }
  }
  const view = pendingSnapshotView(store, [...writes.values()].map(write =>
    ({ id: write.id, kind: write.kind, revision: write.expected + 1, hash: hashJson(write.value), value: copy(write.value) })));
  const pendingSource = historicalTrace(view);
  const rebuilt = invalidations.length
    ? deriveOmInput(pendingSource, { project: request.project, kind: "reopen-facts", previous: request.input, invalidations })
    : delivered(body);
  if (!rebuilt.ok) return rebuilt;
  const facts = currentFactGuards(pendingSource, rebuilt.value as OmInputRecord);
  if (!facts.ok) return facts;
  guards.push(...facts.value);
  const heads = new Map<string, TransactionGuard>();
  for (const guard of guards) {
    const previous = heads.get(guard.id);
    if (previous && canonical(previous) !== canonical(guard))
      return refuse("input_stale", "Recovery observed conflicting source heads", at(guard.id, "head", 'revision' in previous ? previous : undefined), "producer");
    heads.set(guard.id, guard);
  }
  const finalGuards = uniqueTransactionGuards([...heads.values()]);
  if (!invalidations.length) return delivered({ record: body, existing: read.value, writes: [], guards: finalGuards });
  return delivered({ record: rebuilt.value, existing: null,
    writes: [...writes.values(), { id: request.input.id, kind: "om-input", expected: request.input.revision, value: rebuilt.value }],
    guards: finalGuards });
}

/**
 * AT1 door (№4105 п.1–3): the readiness questions one saved G5 of the impact era asks on `previous`. Each unresolved
 * transition its findings name becomes a blocking repository fact, asked once for the works of one block: its consumer is
 * the nearest common block or operation of those works the gate's D1 graph already holds — the works themselves may not
 * be accepted yet; they are the subject of the question. The gate's D1 must stand on `previous` or on a B1 it derives
 * from (B1 → D1/G5 → B1); a cause already open, applied or decided is never asked again.
 */
interface ReadinessGate {
  contract: string; project: string; request: { candidate: Ref; gaps: { sources: { input: Ref; graph: Ref } } };
  result: { findings: { code: string; target: string; field?: string }[] };
  impact?: { snapshot: { commit: string; tree: string } | null;
    works: { work: string; unknowns: { file: string; line: number; kind: string; text: string; site: { start: number; end: number; hash: string }; candidates: string[] }[] }[];
    policies?: { work: string; policy: 'appearance' | 'provider'; producer: string; contract: { id: string; hash: string }; question: string | null }[] };
}
/**
 * RL3 (№4217): the owner's reopening of an accepted L3 (om-regate, the record of frame-proposals.ts, named here by its id and
 * kind so the input stays off the frame modules) asks its door's questions as a saved G5 does: its own findings and impact
 * on its snapshot, the B1 and the accepted graph the door read — the reopened works stand in that graph.
 */
interface ReadinessReopen { contract: string; project: string; input: Ref; graph: Ref; findings: ReadinessGate['result']['findings']; impact?: ReadinessGate['impact'] }
interface ReadinessSource { findings: ReadinessGate['result']['findings']; impact: NonNullable<ReadinessGate['impact']>; input: Ref; graph: Ref; works: Ref | null }
function readinessSource(store: Store, project: string, ref: Ref): InputResult<Sealed<ReadinessSource>> {
  if (ref.id === `om-l3-reopen:${project}`) {
    const read = readRecord<ReadinessReopen>(store, ref, { unit: "G1", target: ref.id, id: ref.id, kind: "om-l3-reopen" });
    if (!read.ok) return transfer("refs", read);
    const reopen = read.value.value as unknown as ReadinessReopen;
    if (reopen.project !== project || reopen.contract !== "om-l3-reopen/v1" || !reopen.impact || !isRef(reopen.input) || !isRef(reopen.graph)
      || !Array.isArray(reopen.findings))
      return refuse("record_forged", "Readiness questions come from the owner's reopening with the door's impact", at(ref.id, "impact", ref), "producer");
    return delivered({ findings: reopen.findings, impact: reopen.impact, input: reopen.input, graph: reopen.graph, works: null });
  }
  const read = readRecord<ReadinessGate>(store, ref, { unit: "G1", target: ref.id, idPrefix: `om-atomic-gate:${project}:`, kind: "om-atomic-gate" });
  if (!read.ok) return transfer("refs", read);
  const gate = read.value.value as unknown as ReadinessGate;
  if (gate.project !== project || gate.contract !== "om-atomic-gate/v2" || !gate.impact)
    return refuse("record_forged", "Readiness questions come from a saved G5 of the impact era", at(ref.id, "impact", ref), "producer");
  return delivered({ findings: gate.result.findings, impact: gate.impact, input: gate.request.gaps.sources.input, graph: gate.request.gaps.sources.graph,
    works: gate.request.candidate });
}
function readinessQuestions(store: Store, project: string, previous: Revision<OmInputRecord>, ref: Ref): InputResult<Sealed<OmInput['questions']>> {
  const source = readinessSource(store, project, ref);
  if (!source.ok) return source;
  const gate = { result: { findings: source.value.findings }, impact: source.value.impact } as unknown as
    { result: ReadinessGate['result']; impact: NonNullable<ReadinessGate['impact']> }, snapshot = gate.impact.snapshot ?? null;
  for (let cursor: Revision<OmInputRecord> = previous; canonical(reference(cursor)) !== canonical(source.value.input);) {
    if (!cursor.value.derivation) return refuse("record_forged", "The gate's D1 must stand on this B1 or one it derives from",
      at(ref.id, "gaps.sources.input", source.value.input), "producer");
    const next = readOmInput(store, project, cursor.value.derivation.previous);
    if (!next.ok) return next;
    cursor = next.value as Revision<OmInputRecord>;
  }
  const accepted = readRecord<Graph>(store, source.value.graph, { unit: "G1", target: ref.id, id: `graph:${project}`, kind: "graph" });
  if (!accepted.ok) return transfer("refs", accepted);
  // The works the questions are about: the candidate's of a G5, the accepted graph's own of a reopening.
  let works: Graph = accepted.value.value as Graph;
  if (source.value.works) {
    const candidate = readRecord<{ graph: Graph }>(store, source.value.works, { unit: "G1", target: ref.id, idPrefix: `om-candidate:${project}:`, kind: "frame-candidate" });
    if (!candidate.ok) return transfer("refs", candidate);
    works = (candidate.value.value as { graph: Graph }).graph;
  }
  type Place = { id: string; kind: string; parent: string | null };
  const places = (nodes: unknown) => new Map((nodes as Place[]).map(node => [node.id, node]));
  const known = places(accepted.value.value.nodes), all = places(works.nodes);
  const chain = (nodes: ReadonlyMap<string, Place>, id: string): string[] => {
    const out: string[] = [];
    for (let node = nodes.get(id); node && !out.includes(node.id); node = node.parent ? nodes.get(node.parent) : undefined) out.push(node.id);
    return out;
  };
  const unresolved = new Set(gate.result.findings.filter(item => item.code === "work_impact_unresolved").map(item => canonical([item.target, item.field ?? ""])));
  const causes = new Map<string, { unknown: NonNullable<ReadinessGate['impact']>['works'][number]['unknowns'][number]; works: string[] }>();
  for (const work of gate.impact.works) for (const unknown of work.unknowns) {
    if (!unresolved.has(canonical([work.work, transitionField(unknown)]))) continue;
    // The cause is the exact place of the transition in the snapshot's file; the excerpt only shows it.
    const key = canonical([unknown.file, unknown.site.start, unknown.site.end, unknown.site.hash]);
    const row = causes.get(key) ?? { unknown, works: [] }; row.works.push(work.work); causes.set(key, row);
  }
  const held = new Set([...previous.value.input.questions, ...(previous.value.input.facts ?? []).map(fact => fact.question),
    ...(previous.value.input.decided ?? []).map(item => item.question)].map(question => question.id));
  const asked: OmInput['questions'] = [];
  // The works of one cause, grouped by their accepted block: each group is asked at the nearest common accepted block or
  // operation above its works.
  const placed = (works: readonly string[]): { consumer: string; works: string[] }[] | Refusal => {
    const groups = new Map<string, { anchors: string[]; works: string[] }>();
    for (const work of [...new Set(works)].sort(order)) {
      const anchor = chain(all, work).slice(1).find(id => ["block", "operation"].includes(known.get(id)?.kind ?? ""));
      const block = anchor ? chain(known, anchor).find(id => known.get(id)!.kind === "block") : undefined;
      if (!anchor || !block) return { code: "question_consumer_missing", message: "A readiness question is asked for an accepted block or operation above its work",
        at: at(work, "consumer", ref), route: "producer" };
      const group = groups.get(block) ?? { anchors: [], works: [] }; group.anchors.push(anchor); group.works.push(work); groups.set(block, group);
    }
    return [...groups.values()].map(group => ({ works: group.works,
      consumer: chain(known, group.anchors[0]!).find(id => group.anchors.every(anchor => chain(known, anchor).includes(id)))! }));
  };
  for (const { unknown, works } of [...causes.values()].sort((a, b) => order(canonical([a.unknown.file, a.unknown.site.start, a.unknown.site.hash]), canonical([b.unknown.file, b.unknown.site.start, b.unknown.site.hash])))) {
    if (!snapshot) return refuse("record_forged", "A transition is asked on the snapshot its gate checked", at(ref.id, "impact.snapshot", ref), "producer");
    const placements = placed(works);
    if (!Array.isArray(placements)) return refuse("question_consumer_missing", placements.message, placements.at, "producer");
    // Return №4186 P1, №4188, №4197: one question for all its works, between blocks too — asked at the first block's place and
    // naming the place in every block its works stand in, so that D1 makes it a gap of each of them.
    const places = [...new Set(placements.map(group => group.consumer))].sort(order);
    const groups = [{ consumer: placements[0]!.consumer, works: placements.flatMap(group => group.works).sort(order), places }];
    for (const group of groups) {
      const consumer = group.consumer;
      const cause: ReadinessCause = { contract: READINESS_CONTRACT, cause: "transition", snapshot: { commit: snapshot.commit, tree: snapshot.tree },
        file: unknown.file, line: unknown.line, kind: unknown.kind, expression: unknown.text, site: { ...unknown.site }, candidates: [...unknown.candidates], works: group.works,
        places: group.places };
      const id = readinessQuestionId(cause, consumer);
      if (held.has(id)) continue;
      held.add(id);
      asked.push({ id, consumer, kind: "repository-fact", blocks: true, source: ref, moment: "om-pass", readiness: cause,
        question: unknown.kind === "declaration"
          ? `Repository snapshot ${snapshot.commit} (tree ${snapshot.tree}), connection point ${unknown.file}: the parser proves nothing about it — `
            + `${unknown.text}. Does the code of that snapshot declare it? Answer with "resolves": ["${unknown.file}"] when it is declared there, [] when it `
            + `is not, and "answer": the evidence. A declaration proves the point exists, not that its interface fits the contract. Works that need it: `
            + `${group.works.join(", ")}.`
          : `Repository snapshot ${snapshot.commit} (tree ${snapshot.tree}), ${unknown.file}${unknown.line ? `:${unknown.line}` : ""}: `
          + `the impact analysis cannot resolve this ${unknown.kind} — ${unknown.text}. Which files of that snapshot can it load when it runs? `
          + `Answer with "resolves": every such file among the ${unknown.candidates.length} candidates the result form lists, [] only when it loads none `
          + `of them, and "answer": the evidence. Works it may affect: ${group.works.join(", ")}.` });
    }
  }
  // AT1 (№4117): a policy G5 found undecided is asked once at its producer — the accepted node the boundary names — for
  // all its consumer works; with no such node, above the works. The owner decides it (H2), or in the pass the model (OWN1).
  const open = new Set(gate.result.findings.filter(item => item.code === "work_policy_open").map(item => canonical([item.target, item.field ?? ""])));
  const policies = new Map<string, { policy: 'appearance' | 'provider'; producer: string; governs: { contract: string; hash: string }; works: string[] }>();
  for (const row of gate.impact.policies ?? []) {
    if (row.question !== null || !open.has(canonical([row.work, `${row.policy}:${row.producer}:${row.contract.id}`]))) continue;
    const key = canonical([row.policy, row.producer, row.contract.id, row.contract.hash]);
    const item = policies.get(key) ?? { policy: row.policy, producer: row.producer, governs: { contract: row.contract.id, hash: row.contract.hash }, works: [] };
    item.works.push(row.work); policies.set(key, item);
  }
  const policyKey = (item: { policy: string; producer: string; governs: { contract: string; hash: string } }) =>
    canonical([item.policy, item.producer, item.governs.contract, item.governs.hash]);
  for (const item of [...policies.values()].sort((a, b) => order(policyKey(a), policyKey(b)))) {
    const producer = known.get(item.producer);
    const groups = producer ? [{ consumer: producer.id, works: [...new Set(item.works)].sort(order) }] : placed(item.works);
    if (!Array.isArray(groups)) return refuse("question_consumer_missing", groups.message, groups.at, "producer");
    for (const group of groups) {
      const cause: ReadinessCause = { contract: READINESS_CONTRACT, cause: "policy", policy: item.policy, producer: item.producer,
        governs: { ...item.governs }, works: group.works };
      const id = readinessQuestionId(cause, group.consumer);
      if (held.has(id)) continue;
      held.add(id);
      asked.push({ id, consumer: group.consumer, kind: "owner-decision", blocks: true, source: ref, moment: "om-pass", readiness: cause,
        question: item.policy === "appearance"
          ? `Durable state of the contract ${item.governs.contract}, written by ${item.producer}: how does it appear? Who creates it and by what; `
            + `what does an entry do when the state is absent; is a first run distinguishable from a loss, and by which sign? Decided once for this `
            + `contract at its producer, for every work of it: ${group.works.join(", ")}.`
          : `Provider of the contract ${item.governs.contract}, called under the authority ${item.producer}: what authority does a call carry, `
            + `how is it repeated, and what happens when its outcome is unknown? Decided once for this contract at its producer, for every work `
            + `that calls it: ${group.works.join(", ")}.` });
    }
  }
  return delivered(asked);
}
/**
 * Whether a saved G5 still has a readiness question the current B1 neither holds nor has answered. A G5 of the era before
 * the impact (om-atomic-gate/v1) has none: its group goes the way it always did (return №4124 P2-6).
 */
export function readinessPending(store: Store, project: string, gate: Ref): InputResult<Sealed<boolean>> {
  return withHistoricalReads(() => {
    // A G5 of the era before the impact asks nothing; RL3: the owner's reopening asks its door's questions like a G5 of the impact era.
    if (gate.id !== `om-l3-reopen:${project}`) {
      const read = readRecord<{ contract?: unknown; project?: unknown }>(store, gate, { unit: "G1", target: gate.id, idPrefix: `om-atomic-gate:${project}:`, kind: "om-atomic-gate" });
      if (!read.ok) return transfer("refs", read);
      if (read.value.value.project === project && read.value.value.contract === "om-atomic-gate/v1") return delivered(false);
    }
    const current = store.get<OmInputRecord>(`om-input:${project}`);
    if (!current) return refuse("input_stale", "Readiness questions are asked on an existing B1", at(`om-input:${project}`, "head"), "producer");
    const asked = readinessQuestions(store, project, current, gate);
    return asked.ok ? delivered(asked.value.length > 0) : asked;
  });
}
export interface ReadinessInputRequest { project: string; input: Ref; gate: Ref }
/** The B1 transition that asks a saved G5's readiness questions; a repeat of a written one is delivered as it is. */
export function prepareReadinessInput(store: Store, request: ReadinessInputRequest): InputResult<Sealed<PreparedOmInput<TransactionGuard>>> {
  return withHistoricalReads(() => {
    if (!object(request) || !text(request.project) || !isRef(request.input) || !isRef(request.gate)
      || Object.keys(request).some(key => !["project", "input", "gate"].includes(key))) invalid("readiness");
    request = copy(request);
    const current = store.get<OmInputRecord>(`om-input:${request.project}`);
    if (!current) return refuse("input_stale", "Readiness questions are asked on an existing B1", at(`om-input:${request.project}`, "head"), "producer");
    const admitted = prepareExistingOmInput(store, request.project, reference(current));
    if (!admitted.ok) return admitted;
    const wanted: ReadinessInputDerivation = { kind: "readiness", previous: request.input, gate: request.gate };
    for (let cursor = admitted.value.existing as Revision<OmInputRecord>; cursor.value.derivation;) {
      if (canonical(cursor.value.derivation) === canonical(wanted))
        return delivered({ record: cursor.value, writes: [], guards: admitted.value.guards, existing: cursor });
      const next = readOmInput(store, request.project, cursor.value.derivation.previous);
      if (!next.ok) return next;
      cursor = next.value as Revision<OmInputRecord>;
    }
    if (canonical(reference(current)) !== canonical(request.input))
      return refuse("input_stale", "New readiness questions are asked on the current B1", at(request.input.id, "head", request.input), "producer");
    const derived = deriveOmInput(store, { project: request.project, ...wanted });
    if (!derived.ok) return derived;
    const guards = uniqueTransactionGuards([...admitted.value.guards, request.gate]);
    if (canonical(derived.value) === canonical(current.value)) return delivered({ record: current.value, writes: [], guards, existing: current });
    return delivered({ record: derived.value as OmInputRecord, existing: null, guards,
      writes: [{ id: current.id, kind: current.kind, expected: current.revision, value: derived.value as OmInputRecord }] });
  });
}
export function writeReadinessInput(store: Store, request: ReadinessInputRequest): InputResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareReadinessInput(store, request);
    if (!prepared.ok) return prepared;
    if (!prepared.value.writes.length) return delivered(prepared.value.existing!);
    const result = writeGuarded<OmInputRecord>(store, { unit: "G1", target: `om-input:${request.project}`,
      writes: prepared.value.writes as Write[], guards: prepared.value.guards as TransactionGuard[] });
    if (!result.ok) return transfer("refs", result);
    return delivered(result.value[0]!);
  });
}

import { Ajv } from "ajv";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { discoveryConstraintBindings, discoveryContext, discoveryDecisionId, discoveryOutcome,
  type DiscoveryChoice, type DiscoveryChoiceOption, type DiscoveryConditionDecision } from "../discovery/discovery-outcome.js";
import { readAcceptedResearchAnswer, type Decision, type DiscoveryDraft, type Fact, type Question } from "../discovery/discovery.js";
import { LEGACY_REQUIREMENTS, REQUIREMENTS, UPSTREAM_STAGES, VERSION2_REQUIREMENTS, VERSION3_REQUIREMENTS,
  VERSION4_REQUIREMENTS, type UpstreamStage } from "../discovery/requirements.js";
import type { ResearchAssessment, ResearchRun } from "../discovery/research-model.js";
import { EngineError, requireCondition } from "../errors.js";
import type { Observation, Selector, Source } from "../evidence/evidence.js";
import { runtimeEvidenceDependencies } from "../graph/runtime-evidence.js";
import { isRef, predecessor, reference, STAGES, stageId, uniqueRefs, type Ref, type Stage, type StageArtifact } from "../pipeline/contracts.js";
import { type StageContent } from "./stage-checks.js";
import { Store, type Revision, type Write } from "../storage/store.js";
import { storeView } from "../storage/store-view.js";

export type SummaryOriginLabel = "Слова поручения (дословно)" | "Факт источника"
  | "Решение вызывающего" | "Предложение модели, принято по оценке" | "Проектное предложение";

export interface SummaryAddress { record: Ref; pointer: string }
export interface SummaryLocated { value: Json; address: SummaryAddress }
export interface SummarySource {
  ref: Ref; kind: Source["origin"]["kind"]; location: string; selector: Selector; quote: string;
  proofLimit: "repository-observation" | "quoted-intent-requires-attribution" | "reported-not-runtime-proof";
  requestedUrl: string | null; finalUrl: string | null; fetchedAt: string | null; status: number | null;
}
export interface SummaryOrigin {
  label: SummaryOriginLabel; record: Ref; author: string | null; assessment: Ref | null;
  binding: Ref | null; source: SummarySource | null;
}
export interface SummaryField {
  field: string; value: Json; address: SummaryAddress; question: Ref; answer: Ref; origin: SummaryOrigin;
}
export interface SummaryCitation extends SummarySource { index: number; value: Json }
export interface SummaryReportResult {
  id: string; question: string; conclusion: string; limits: string[]; address: SummaryAddress; citations: SummaryCitation[];
}
export interface SummaryResearchReport {
  field: SummaryField; results: SummaryReportResult[]; openQuestions: SummaryLocated[];
  variant: string; constraints: SummaryLocated[];
}
export interface SummaryResearchVerdict {
  field: SummaryField; outcome: "go" | "conditional" | "no_go" | "insufficient_evidence";
  variant: string; reason: string; bases: SummaryLocated[]; conditions: SummaryLocated[];
}
export interface SummaryAccepted {
  state: "accepted" | "previously_accepted"; artifact: Ref; draft: Ref; contractVersion: number;
  instruction: { brief: SummaryField; objective: SummaryField };
  researchPlan: SummaryField | null;
  report: SummaryResearchReport | null;
  verdict: SummaryResearchVerdict | null;
  preparation: SummaryField | null;
  limitations: string[];
}
export interface SummaryQuestion { ref: Ref; field: string; status: Question["status"] }
export interface SummaryRun {
  ref: Ref; status: ResearchRun["status"]; pauseCode: string | null; error: string | null;
  question: Ref | null; missing: string[]; door: string | null;
}
export interface SummaryOwnerChoice extends DiscoveryChoice { address: SummaryAddress }
export interface SummaryChoiceDecision {
  ref: Ref; round: Ref | null; verdict: Ref; conditionId: string; optionId: string;
  option: string; choice: "accept" | "decline"; actor: string;
}
export interface SummaryFailure { code: string; message: string; question: Ref | null }
export interface SummaryCandidate {
  draft: Ref; contractVersion: number; state: "legacy" | "researching" | "go" | "conditional" | "no_go" | "insufficient_evidence";
  researchPlan: SummaryField | null; report: SummaryResearchReport | null; verdict: SummaryResearchVerdict | null;
  questionFailure: SummaryFailure | null; admission: SummaryFailure | null; outcomeFailure: SummaryFailure | null;
  researchFailure: SummaryFailure | null; choiceHistoryFailure: SummaryFailure | null; runFailure: SummaryFailure | null;
  reason: string | null; reasonAddress: SummaryAddress | null;
  conditions: SummaryLocated[]; ownerChoices: SummaryOwnerChoice[]; decisions: SummaryChoiceDecision[];
  questions: SummaryQuestion[]; run: SummaryRun | null; door: string | null;
}
export interface DiscoveryStageSummary {
  contract: "stage-summary/discovery/v1"; project: string; stage: "discovery"; currentStage: Ref | null;
  accepted: SummaryAccepted | null; candidate: SummaryCandidate | null; candidates: Ref[];
}

export type SummaryStructuredStage = Exclude<UpstreamStage, "discovery">;
export interface SummaryJourney {
  id: string; actor: SummaryLocated; entry: SummaryLocated; nodes: SummaryLocated[];
  transitions: SummaryLocated[]; outcome: SummaryLocated; terminal: string; address: SummaryAddress;
}
export interface SummaryLayer {
  ref: Ref; projection: SummaryLocated; journeys: SummaryJourney[]; fullGraph: Ref | null;
  currentGraph: Ref | null; currentLayer: Ref | null; acceptedPathChanged: boolean | null;
  fullGraphChanged: boolean | null; limitations: string[];
}
export type SummaryStageMaterial =
  | { stage: "concept"; overview: SummaryField[]; sections: SummaryField | null }
  | { stage: "operation-map"; legacyJourney: SummaryField | null; requirements: SummaryField | null;
      design: SummaryField | null; layer: SummaryLayer }
  | { stage: "specification"; behavior: SummaryField | null; constraints: SummaryField | null;
      behaviorContracts: SummaryField | null }
  | { stage: "features"; features: SummaryField | null; preparation: SummaryField | null };
export interface SummaryStructuredAccepted {
  state: "accepted" | "previously_accepted"; artifact: Ref; draft: Ref; contractVersion: number;
  fields: SummaryField[]; material: SummaryStageMaterial; limitations: string[];
}
export interface SummaryStructuredCandidate {
  draft: Ref; contractVersion: number;
  state: "ready" | ResearchRun["status"];
  fields: (SummaryLocated & { field: string })[]; questions: SummaryQuestion[];
  upstreamFailure: SummaryFailure | null; questionFailure: SummaryFailure | null;
  graphFailure: SummaryFailure | null; run: SummaryRun | null; runFailure: SummaryFailure | null;
  door: string | null;
}
export interface StructuredStageSummary {
  contract: "stage-summary/upstream/v1"; project: string; stage: SummaryStructuredStage; currentStage: Ref | null;
  accepted: SummaryStructuredAccepted | null; candidate: SummaryStructuredCandidate | null; candidates: Ref[];
}
export type StageSummary = DiscoveryStageSummary | StructuredStageSummary;

interface EarlyStageInput {
  contract: "early-stage-input/v1"; projectId: string; project: Ref; source: Ref; brief: Selector;
  objective: { kind: "brief" } | { kind: "source"; selector: Selector }; actor: "driver:verbatim";
}
interface FieldRead { summary: SummaryField; record: Revision<Decision | Fact | { projectId: string; question: string; assessment: Ref; value: Json }>;
  assessment: Revision<ResearchAssessment> | null }
interface ExactProofReader { require<T>(ref: Ref, role: string): Revision<T> }

const ajv = new Ajv({ strict: true, allowUnionTypes: true });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const exact = <T>(store: Store, ref: Ref, code = "stage_summary_dependency_missing"): Revision<T> => {
  const record = store.get<T>(ref.id, ref.revision);
  requireCondition(record && record.hash === ref.hash, code, `[${ref.id}@${ref.revision}] The exact saved dependency is unavailable`);
  return record;
};
const address = (record: Ref, pointer: string): SummaryAddress => ({ record, pointer });

class AcceptedProofs {
  readonly refs = new Map<string, Ref>();
  readonly view: Store;
  constructor(readonly store: Store, readonly artifact: Revision<StageArtifact>) {
    for (const ref of artifact.value.proofs) {
      const prior = this.refs.get(ref.id);
      requireCondition(!prior || same(prior, ref), "stage_summary_proof_ambiguous",
        `[${ref.id}] The accepted stage names more than one revision of a dependency`);
      this.refs.set(ref.id, ref);
      exact(store, ref);
    }
    this.refs.set(artifact.id, reference(artifact));
    this.view = storeView(store, {
      get: (id, revision) => {
        if (revision !== undefined) return undefined;
        const ref = this.refs.get(id);
        return ref ? exact(store, ref) : undefined;
      },
      write: (_writes: Write[]) => { throw new EngineError("stage_summary_read_only", "Stage summary cannot write product records"); },
    });
  }
  require<T>(ref: Ref, role: string): Revision<T> {
    const proof = this.refs.get(ref.id);
    requireCondition(proof && same(proof, ref), "stage_summary_proof_missing",
      `[${ref.id}@${ref.revision}] The accepted stage did not preserve its ${role} proof`);
    return exact<T>(this.store, ref);
  }
  head<T>(id: string, role: string): Revision<T> {
    const ref = this.refs.get(id);
    requireCondition(ref, "stage_summary_proof_missing", `[${id}] The accepted stage did not preserve its ${role} proof`);
    return exact<T>(this.store, ref);
  }
}

function selectSaved(source: Revision<Source>, selector: Selector): Json {
  requireCondition(source.kind === "source" && source.value && typeof source.value.content === "string"
    && digest(source.value.content) === source.value.sha256 && hashJson(source.value) === source.hash,
  "stage_summary_source_invalid", `[${source.id}] The saved Source cannot reproduce its captured bytes`);
  let value: unknown;
  if (selector.kind === "text-range") {
    requireCondition(Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
      && selector.start >= 0 && selector.end > selector.start && selector.end <= source.value.content.length,
    "stage_summary_selector_invalid", `[${source.id}] The saved text selector is invalid`);
    value = source.value.content.slice(selector.start, selector.end);
  } else {
    requireCondition(source.value.mediaType === "application/json" && typeof selector.pointer === "string"
      && (selector.pointer === "" || selector.pointer.startsWith("/")),
    "stage_summary_selector_invalid", `[${source.id}] The saved JSON selector is invalid`);
    value = JSON.parse(source.value.content);
    if (selector.pointer) for (const encoded of selector.pointer.slice(1).split("/")) {
      requireCondition(!/~(?![01])/.test(encoded), "stage_summary_selector_invalid", `[${source.id}] The saved JSON pointer is invalid`);
      const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      requireCondition(object(value) || Array.isArray(value), "stage_summary_selector_invalid", `[${source.id}] The saved JSON pointer leaves the document`);
      requireCondition(Object.hasOwn(value, key), "stage_summary_selector_invalid", `[${source.id}] The saved JSON pointer names no value`);
      value = (value as Record<string, unknown>)[key];
    }
  }
  return JSON.parse(canonical(value)) as Json;
}

function sourceSummary(proofs: ExactProofReader, project: string, observation: Observation): SummarySource {
  requireCondition(observation.projectId === project && isRef(observation.source), "stage_summary_observation_invalid",
    "A saved citation must belong to this project and retain its exact Source");
  const source = proofs.require<Source>(observation.source, "citation Source");
  const origin = source.value?.origin;
  requireCondition(source.kind === "source" && source.value.projectId === project
    && origin !== null && typeof origin === "object" && ["file", "owner-document", "web"].includes(origin.kind),
  "stage_summary_source_invalid", `[${source.id}] The saved citation Source is malformed or belongs to another project`);
  const selected = selectSaved(source, observation.selector);
  requireCondition(same(selected, observation.value), "stage_summary_observation_invalid",
    `[${source.id}] The saved citation differs from the exact captured Source bytes`);
  const web = origin.kind === "web" ? origin : null;
  return { ref: reference(source), kind: origin.kind, location: origin.location, selector: observation.selector,
    quote: typeof observation.value === "string" ? observation.value : canonical(observation.value),
    proofLimit: origin.kind === "file" ? "repository-observation"
      : origin.kind === "owner-document" ? "quoted-intent-requires-attribution" : "reported-not-runtime-proof",
    requestedUrl: web?.requestedUrl ?? null, finalUrl: web?.finalUrl ?? null,
    fetchedAt: web?.fetchedAt ?? null, status: web?.status ?? null };
}

function currentProofs(store: Store): ExactProofReader {
  return { require<T>(ref: Ref): Revision<T> { return exact<T>(store, ref); } };
}

function candidateFailure(error: unknown, questions: Revision<Question>[]): SummaryFailure {
  if (!(error instanceof EngineError)) throw error;
  const target = /^\[([^\]]+)\]/.exec(error.message)?.[1];
  const question = target ? questions.find(item => item.id === target) : undefined;
  return { code: error.code, message: error.message, question: question ? reference(question) : null };
}

function requirements(version: number, stage: UpstreamStage) {
  return (version === 1 ? LEGACY_REQUIREMENTS : version === 2 ? VERSION2_REQUIREMENTS
    : version === 3 ? VERSION3_REQUIREMENTS : version === 4 ? VERSION4_REQUIREMENTS : REQUIREMENTS)[stage];
}

function researchReportSummary(proofs: ExactProofReader, project: string, plan: FieldRead,
  reportRead: FieldRead): SummaryResearchReport {
  requireCondition(plan.assessment && reportRead.assessment,
    "stage_summary_assessment_invalid", "A saved Discovery report needs exact supported plan and report assessments");
  const reportValue = reportRead.summary.value as unknown as { researchPlan: Ref;
    results: { id: string; question: string; conclusion: string; citations: number[]; limits: string[] }[];
    openQuestions: Json[]; variant: string; constraints: string[] };
  requireCondition(same(reportValue.researchPlan, plan.summary.answer), "stage_summary_basis_invalid",
    "The saved report does not name the exact saved research plan");
  const results = reportValue.results.map((result, index): SummaryReportResult => ({ id: result.id, question: result.question,
    conclusion: result.conclusion, limits: result.limits,
    address: address(reportRead.summary.answer, `/value/results/${index}`),
    citations: result.citations.map(citation => {
      const observation = reportRead.assessment!.value.observations[citation];
      requireCondition(observation, "stage_summary_citation_invalid",
        `[${result.id}] Citation ${citation} is absent from the saved assessment`);
      return { index: citation, value: observation.value, ...sourceSummary(proofs, project, observation) };
    }) }));
  return { field: reportRead.summary, results,
    openQuestions: reportValue.openQuestions.map((value, index) =>
      ({ value, address: address(reportRead.summary.answer, `/value/openQuestions/${index}`) })),
    variant: reportValue.variant,
    constraints: reportValue.constraints.map((value, index) =>
      ({ value, address: address(reportRead.summary.answer, `/value/constraints/${index}`) })) };
}

function researchVerdictSummary(reportRead: FieldRead, verdictRead: FieldRead,
  accepted: boolean): SummaryResearchVerdict {
  requireCondition(reportRead.assessment && verdictRead.assessment,
    "stage_summary_assessment_invalid", "A saved Discovery verdict needs exact supported report and verdict assessments");
  const reportValue = reportRead.summary.value as unknown as { results: { id: string }[]; openQuestions: Json[] };
  const verdictValue = verdictRead.summary.value as unknown as { researchReport: Ref;
    outcome: "go" | "conditional" | "no_go" | "insufficient_evidence";
    reason: string; variant: string; bases: Json[]; conditions: Json[] };
  requireCondition(same(verdictValue.researchReport, reportRead.summary.answer)
    && (!accepted || verdictValue.outcome === "go" && verdictValue.conditions.length === 0),
  "stage_summary_basis_invalid", accepted
    ? "An accepted Discovery stage needs the exact report and a go verdict without conditions"
    : "The saved Discovery verdict does not name its exact report");
  const reportIds = new Set([...reportValue.results, ...reportValue.openQuestions]
    .map(item => object(item) && typeof item.id === "string" ? item.id : null).filter((id): id is string => id !== null));
  requireCondition(verdictValue.bases.every(item => object(item) && typeof item.result === "string" && reportIds.has(item.result)),
    "stage_summary_basis_invalid", "The saved verdict names a result outside its exact report");
  return { field: verdictRead.summary, outcome: verdictValue.outcome, variant: verdictValue.variant,
    reason: verdictValue.reason,
    bases: verdictValue.bases.map((value, index) =>
      ({ value, address: address(verdictRead.summary.answer, `/value/bases/${index}`) })),
    conditions: verdictValue.conditions.map((value, index) =>
      ({ value, address: address(verdictRead.summary.answer, `/value/conditions/${index}`) })) };
}

function readAcceptedField(proofs: AcceptedProofs, artifact: Revision<StageArtifact>, draft: Revision<DiscoveryDraft>, field: string): FieldRead {
  const matches = draft.value.questions.map(id => proofs.head<Question>(id, `${field} question`))
    .filter(question => question.value.spec.field === field);
  requireCondition(matches.length === 1, "stage_summary_question_invalid",
    `[${draft.id}] ${draft.value.stage} needs exactly one ${field} question`);
  const question = matches[0]!;
  requireCondition(question.kind === "question" && question.value.projectId === draft.value.projectId
    && question.value.draftId === draft.id && question.value.status === "answered" && isRef(question.value.answer),
  "stage_summary_question_invalid", `[${question.id}] The accepted ${field} question is incomplete or foreign`);
  const answerRef = question.value.answer;
  const record = proofs.require<Decision | Fact | { projectId: string; question: string; assessment: Ref; value: Json }>(answerRef, `${field} answer`);
  requireCondition(record.value.projectId === draft.value.projectId && record.value.question === question.id,
    "stage_summary_answer_invalid", `[${record.id}] The accepted ${field} answer belongs to another question`);
  let value: Json, origin: SummaryOrigin, assessment: Revision<ResearchAssessment> | null = null;
  if (record.kind === "fact") {
    const fact = record.value as Fact;
    const source = sourceSummary(proofs, draft.value.projectId, fact.observation);
    value = fact.observation.value;
    origin = { label: "Факт источника", record: reference(record), author: null, assessment: null, binding: null, source };
  } else if (record.kind === "research-answer") {
    const research = record.value as { projectId: string; question: string; assessment: Ref; value: Json };
    const accepted = readAcceptedResearchAnswer(proofs.view, draft.value.projectId, answerRef);
    assessment = accepted.assessment;
    requireCondition(assessment?.kind === "research-assessment" && assessment.value.verdict === "supported"
      && same(assessment.value.value, research.value), "stage_summary_assessment_invalid",
    `[${record.id}] The accepted model proposal has no exact supported assessment`);
    proofs.require(reference(assessment), `${field} assessment`);
    if (accepted.binding) proofs.require(reference(accepted.binding), `${field} acceptance binding`);
    for (const dependency of runtimeEvidenceDependencies(assessment.value.runtimeProofs ?? []))
      proofs.require(dependency, `${field} runtime evidence dependency`);
    for (const observation of assessment.value.observations) sourceSummary(proofs, draft.value.projectId, observation);
    value = research.value;
    origin = { label: "Предложение модели, принято по оценке", record: reference(record), author: assessment.value.researcher,
      assessment: reference(assessment), binding: accepted.binding ? reference(accepted.binding) : null, source: null };
  } else {
    requireCondition(record.kind === question.value.spec.kind && (record.kind === "decision" || record.kind === "design"),
      "stage_summary_answer_invalid", `[${record.id}] The accepted ${field} answer has the wrong kind`);
    const decision = record.value as Decision;
    requireCondition(typeof decision.actor === "string" && decision.actor.trim().length > 0,
      "stage_summary_answer_invalid", `[${record.id}] The accepted ${field} decision has no author`);
    value = decision.value;
    origin = { label: record.kind === "design" ? "Проектное предложение" : "Решение вызывающего",
      record: reference(record), author: decision.actor, assessment: null, binding: null, source: null };
  }
  const validator = ajv.compile(question.value.spec.schema as object);
  requireCondition(validator(value) && same(value, draft.value.fields[field]), "stage_summary_answer_invalid",
    `[${record.id}] The accepted ${field} value cannot be reproduced from its answer`);
  return { summary: { field, value, address: address(reference(artifact), `/content/fields/${field}`),
    question: reference(question), answer: answerRef, origin }, record, assessment };
}

function applyVerbatimOrigin(proofs: AcceptedProofs, draft: Revision<DiscoveryDraft>, fields: Map<string, FieldRead>): void {
  const bindings = draft.value.inputs.map(ref => proofs.require<unknown>(ref, "Discovery input"))
    .filter(record => record.kind === "early-stage-input");
  if (!bindings.length) return;
  requireCondition(bindings.length === 1, "instruction_binding_invalid", `[${draft.id}] Discovery names more than one early-stage input`);
  const binding = bindings[0] as Revision<EarlyStageInput>, value = binding.value;
  requireCondition(value?.contract === "early-stage-input/v1" && value.projectId === draft.value.projectId
    && value.actor === "driver:verbatim" && isRef(value.project) && isRef(value.source)
    && object(value.objective) && (value.objective.kind === "brief" || value.objective.kind === "source"),
  "instruction_binding_invalid", `[${binding.id}] The saved early-stage input is incomplete or foreign`);
  const project = proofs.require<{ id: string }>(value.project, "instruction project");
  const source = proofs.require<Source>(value.source, "instruction Source");
  requireCondition(project.kind === "project" && project.value.id === draft.value.projectId
    && source.kind === "source" && source.value.projectId === draft.value.projectId && source.value.origin.kind === "owner-document",
  "instruction_binding_invalid", `[${binding.id}] The saved instruction does not resolve to this project and owner document`);
  const brief = selectSaved(source, value.brief);
  const objectiveSelector = value.objective.kind === "brief" ? value.brief : value.objective.selector;
  const objective = value.objective.kind === "brief" ? brief : selectSaved(source, objectiveSelector);
  for (const [name, selected, selector] of [["brief", brief, value.brief], ["objective", objective, objectiveSelector]] as const) {
    const field = fields.get(name);
    requireCondition(field && same(field.summary.value, selected), "instruction_answer_stale",
      `[${binding.id}] The accepted ${name} differs from its exact instruction selector`);
    if (name === "brief") {
      requireCondition(field.record.kind === "fact" && same((field.record.value as Fact).observation,
        { projectId: draft.value.projectId, source: value.source, selector, value: selected }),
      "instruction_answer_stale", `[${field.record.id}] The accepted brief is not the exact instruction observation`);
    } else requireCondition(field.record.kind === "decision" && (field.record.value as Decision).actor === "driver:verbatim"
      && same((field.record.value as Decision).value, selected), "instruction_answer_stale",
    `[${field.record.id}] The accepted objective was not copied by the input driver`);
    field.summary.origin = { label: "Слова поручения (дословно)", record: field.summary.answer,
      author: "driver:verbatim", assessment: null, binding: reference(binding),
      source: { ref: reference(source), kind: source.value.origin.kind, location: source.value.origin.location, selector,
        quote: typeof selected === "string" ? selected : canonical(selected), proofLimit: "quoted-intent-requires-attribution",
        requestedUrl: null, finalUrl: null, fetchedAt: null, status: null } };
  }
}

function readAccepted(store: Store, artifact: Revision<StageArtifact>, current: Revision<StageArtifact> | null): SummaryAccepted {
  requireCondition(artifact.kind === "stage" && artifact.value.projectId && artifact.value.stage === "discovery"
    && artifact.value.status === "accepted" && Array.isArray(artifact.value.inputs) && artifact.value.inputs.length === 0
    && Array.isArray(artifact.value.proofs), "stage_summary_artifact_invalid",
  `[${artifact.id}] The accepted Discovery artifact is malformed or foreign`);
  const content = artifact.value.content as unknown as StageContent;
  requireCondition(object(content) && isRef(content.draft) && object(content.fields) && content.graph === null
    && Object.keys(content).sort().join(",") === "draft,fields,graph", "stage_summary_artifact_invalid",
  `[${artifact.id}] The accepted Discovery content has an invalid shape`);
  const proofs = new AcceptedProofs(store, artifact);
  const draft = proofs.require<DiscoveryDraft>(content.draft, "Discovery draft");
  const version = draft.value.contractVersion ?? 1;
  requireCondition(draft.kind === "discovery-draft" && draft.value.projectId === artifact.value.projectId
    && draft.value.stage === "discovery" && draft.value.level === "R0" && [1, 2, 3, 4, 5].includes(version)
    && same(draft.value.fields, content.fields), "stage_summary_draft_invalid",
  `[${draft.id}] The accepted Discovery draft is malformed, foreign or differs from the stage`);
  const expected = requirements(version, "discovery");
  const specs = draft.value.questions.map(id => proofs.head<Question>(id, "Discovery question").value.spec);
  requireCondition(same(specs, expected), "stage_summary_contract_invalid",
    `[${draft.id}] The accepted Discovery questions do not match contract version ${version}`);
  const fields = new Map<string, FieldRead>();
  for (const spec of expected) fields.set(spec.field, readAcceptedField(proofs, artifact, draft, spec.field));
  applyVerbatimOrigin(proofs, draft, fields);
  const brief = fields.get("brief")!, objective = fields.get("objective")!;
  const limitations: string[] = [];
  let researchPlan: SummaryField | null = null, report: SummaryAccepted["report"] = null;
  let verdict: SummaryAccepted["verdict"] = null, preparation: SummaryField | null = fields.get("preparation")?.summary ?? null;
  if (version < 5) {
    limitations.push(`researchPlan отсутствует в contractVersion ${version}`,
      `researchReport отсутствует в contractVersion ${version}`, `verdict отсутствует в contractVersion ${version}`);
  } else {
    const plan = fields.get("researchPlan")!, reportRead = fields.get("researchReport")!, verdictRead = fields.get("verdict")!;
    researchPlan = plan.summary;
    report = researchReportSummary(proofs, artifact.value.projectId, plan, reportRead);
    verdict = researchVerdictSummary(reportRead, verdictRead, true);
    const selected = { researchPlan: { question: plan.summary.question, answer: plan.summary.answer, value: plan.summary.value },
      researchReport: { question: reportRead.summary.question, answer: reportRead.summary.answer, value: reportRead.summary.value },
      verdict: { question: verdictRead.summary.question, answer: verdictRead.summary.answer, value: verdictRead.summary.value } };
    const expectedConstraints = discoveryConstraintBindings(selected);
    const preparationValue = preparation?.value as unknown as { constraints?: { basis: string; rule: string }[] } | undefined;
    requireCondition(preparation && Array.isArray(preparationValue?.constraints)
      && expectedConstraints.every(row => preparationValue.constraints!.some(item => item.basis === row.basis && item.rule === row.rule)),
    "stage_summary_basis_invalid", "The accepted preparation lost a constraint of its exact research report");
  }
  return { state: current && current.revision === artifact.revision && current.hash === artifact.hash ? "accepted" : "previously_accepted",
    artifact: reference(artifact), draft: reference(draft), contractVersion: version,
    instruction: { brief: brief.summary, objective: objective.summary }, researchPlan, report, verdict, preparation, limitations };
}

function readCandidateResearchField(store: Store, draft: Revision<DiscoveryDraft>,
  question: Revision<Question>): FieldRead {
  const answerRef = question.value.answer;
  requireCondition(question.value.status === "answered" && isRef(answerRef),
    "stage_summary_question_invalid", `[${question.id}] The saved research question is incomplete`);
  const accepted = readAcceptedResearchAnswer(store, draft.value.projectId, answerRef);
  const record = accepted.answer;
  const assessment = accepted.assessment;
  requireCondition(record.kind === "research-answer" && record.value.projectId === draft.value.projectId
    && record.value.question === question.id && assessment?.kind === "research-assessment"
    && assessment.value.verdict === "supported" && same(assessment.value.value, record.value.value),
  "stage_summary_assessment_invalid", `[${question.id}] The saved research answer has no exact supported assessment`);
  const proofs = currentProofs(store);
  if (accepted.binding) proofs.require(reference(accepted.binding), `${question.value.spec.field} acceptance binding`);
  for (const dependency of runtimeEvidenceDependencies(assessment.value.runtimeProofs ?? []))
    proofs.require(dependency, `${question.value.spec.field} runtime evidence dependency`);
  for (const observation of assessment.value.observations)
    sourceSummary(proofs, draft.value.projectId, observation);
  const validator = ajv.compile(question.value.spec.schema as object);
  requireCondition(validator(record.value.value) && same(record.value.value, draft.value.fields[question.value.spec.field]),
    "stage_summary_answer_invalid", `[${question.id}] The saved research answer cannot reproduce its candidate field`);
  return { summary: { field: question.value.spec.field, value: record.value.value,
    address: address(answerRef, "/value"), question: reference(question), answer: answerRef,
    origin: { label: "Предложение модели, принято по оценке", record: answerRef,
      author: assessment.value.researcher, assessment: reference(assessment),
      binding: accepted.binding ? reference(accepted.binding) : null, source: null } },
  record, assessment };
}

function candidateResearch(store: Store, project: string, draft: Revision<DiscoveryDraft>,
  records: Revision<Question>[]): { researchPlan: SummaryField | null; report: SummaryResearchReport | null;
    verdict: SummaryResearchVerdict | null; failure: SummaryFailure | null } {
  let researchPlan: SummaryField | null = null, report: SummaryResearchReport | null = null;
  let verdict: SummaryResearchVerdict | null = null, failure: SummaryFailure | null = null;
  if ((draft.value.contractVersion ?? 1) !== 5) return { researchPlan, report, verdict, failure };
  const readable = (field: string): Revision<Question> | null => {
    const index = records.findIndex(question => question.value.spec.field === field);
    if (index < 0 || !records.slice(0, index + 1).every(question => question.value.status === "answered")) return null;
    return records[index]!;
  };
  try {
    const planQuestion = readable("researchPlan");
    if (!planQuestion) return { researchPlan, report, verdict, failure };
    const planRead = readCandidateResearchField(store, draft, planQuestion);
    researchPlan = planRead.summary;
    const reportQuestion = readable("researchReport");
    if (!reportQuestion) return { researchPlan, report, verdict, failure };
    const reportRead = readCandidateResearchField(store, draft, reportQuestion);
    report = researchReportSummary(currentProofs(store), project, planRead, reportRead);
    const verdictQuestion = readable("verdict");
    if (!verdictQuestion) return { researchPlan, report, verdict, failure };
    const verdictRead = readCandidateResearchField(store, draft, verdictQuestion);
    verdict = researchVerdictSummary(reportRead, verdictRead, false);
  } catch (error) { failure = candidateFailure(error, records); }
  return { researchPlan, report, verdict, failure };
}

interface SavedLayer {
  projection: Json; inputs: Ref[]; obligations: Json[]; layerProofs?: Json[];
}
interface SavedGraphBinding { graph: Ref; inputs: Ref[]; actor: string }

const json = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const pointerToken = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");
const located = (record: Ref, pointer: string, value: unknown): SummaryLocated =>
  ({ value: json(value), address: address(record, pointer) });

function layerSummary(store: Store, proofs: AcceptedProofs, project: string, layerRef: Ref): SummaryLayer {
  requireCondition(layerRef.id === `graph-layer:${project}:1`, "stage_summary_layer_invalid",
    `[${layerRef.id}@${layerRef.revision}/projection] The accepted operation map does not name its L1 layer`);
  const layer = proofs.require<SavedLayer>(layerRef, "accepted L1 layer");
  requireCondition(layer.kind === "graph-layer" && object(layer.value) && object(layer.value.projection)
    && layer.value.projection.level === 1 && Array.isArray(layer.value.projection.nodes)
    && Array.isArray(layer.value.projection.artifacts) && Array.isArray(layer.value.projection.connectors),
  "stage_summary_layer_invalid", `[${layerRef.id}@${layerRef.revision}/projection] The accepted L1 projection is incomplete`);
  const projection = layer.value.projection;
  const limitations: string[] = [];
  const journeys: SummaryJourney[] = [];
  if (projection.version === 2) {
    requireCondition(Array.isArray(projection.actors) && Array.isArray(projection.edges) && Array.isArray(projection.journeys),
      "stage_summary_layer_invalid", `[${layerRef.id}@${layerRef.revision}/projection] Enriched L1 needs actors, edges and journeys`);
    const actors = projection.actors as Json[], nodes = projection.nodes as Json[], artifacts = projection.artifacts as Json[];
    const edges = projection.edges as Json[], connectors = projection.connectors as Json[];
    for (const [journeyIndex, rawJourney] of (projection.journeys as Json[]).entries()) {
      requireCondition(object(rawJourney) && typeof rawJourney.id === "string" && typeof rawJourney.actor === "string"
        && typeof rawJourney.entry === "string" && Array.isArray(rawJourney.path) && rawJourney.path.length > 0
        && rawJourney.path.every(item => typeof item === "string") && typeof rawJourney.outcome === "string"
        && typeof rawJourney.terminal === "string", "stage_summary_layer_invalid",
      `[${layerRef.id}@${layerRef.revision}/projection/journeys/${journeyIndex}] The accepted journey is incomplete`);
      const actorIndex = actors.findIndex(item => object(item) && item.id === rawJourney.actor);
      const outcomeIndex = artifacts.findIndex(item => object(item) && item.id === rawJourney.outcome);
      requireCondition(actorIndex >= 0 && outcomeIndex >= 0 && rawJourney.path[0] === rawJourney.entry,
        "stage_summary_layer_invalid",
        `[${layerRef.id}@${layerRef.revision}/projection/journeys/${journeyIndex}] The accepted journey has an unresolved actor, entry or outcome`);
      const journeyNodes = rawJourney.path.map((nodeId, pathIndex) => {
        const nodeIndex = nodes.findIndex(item => object(item) && item.id === nodeId);
        requireCondition(nodeIndex >= 0, "stage_summary_layer_invalid",
          `[${layerRef.id}@${layerRef.revision}/projection/journeys/${journeyIndex}/path/${pathIndex}] The accepted journey names no L1 node`);
        return located(layerRef, `/projection/nodes/${nodeIndex}`, nodes[nodeIndex]);
      });
      const transitions: SummaryLocated[] = [];
      for (let pathIndex = 1; pathIndex < rawJourney.path.length; pathIndex++) {
        const before = transitions.length;
        const from = rawJourney.path[pathIndex - 1], to = rawJourney.path[pathIndex];
        const edgeIndexes = edges.map((item, index) => object(item) && item.source === from && item.target === to ? index : -1)
          .filter(index => index >= 0);
        for (const edgeIndex of edgeIndexes) transitions.push(located(layerRef, `/projection/edges/${edgeIndex}`, edges[edgeIndex]));
        for (const [connectorIndex, connector] of connectors.entries()) {
          if (!object(connector) || !Array.isArray(connector.bindings)) continue;
          for (const [bindingIndex, binding] of connector.bindings.entries()) if (object(binding)
            && object(binding.producer) && binding.producer.node === from && Array.isArray(binding.consumers)
            && binding.consumers.some(consumer => object(consumer) && consumer.node === to)) {
            transitions.push(located(layerRef, `/projection/connectors/${connectorIndex}/bindings/${bindingIndex}`,
              { kind: "connector", id: connector.id, artifact: connector.artifact, binding }));
          }
        }
        requireCondition(transitions.length > before, "stage_summary_layer_invalid",
          `[${layerRef.id}@${layerRef.revision}/projection/journeys/${journeyIndex}/path/${pathIndex}] The accepted journey has no saved transition`);
      }
      journeys.push({ id: rawJourney.id,
        actor: located(layerRef, `/projection/actors/${actorIndex}`, actors[actorIndex]),
        entry: located(layerRef, `/projection/journeys/${journeyIndex}/entry`, rawJourney.entry), nodes: journeyNodes,
        transitions, outcome: located(layerRef, `/projection/artifacts/${outcomeIndex}`, artifacts[outcomeIndex]),
        terminal: rawJourney.terminal, address: address(layerRef, `/projection/journeys/${journeyIndex}`) });
    }
  } else limitations.push("Эта эра L1 не сохраняла actors/edges/journeys; legacy journey показан только как поле стадии");

  const bindingRef = proofs.refs.get(`graph-binding:${project}`);
  let fullGraph: Ref | null = null;
  if (bindingRef) {
    const binding = proofs.require<SavedGraphBinding>(bindingRef, "accepted graph binding");
    requireCondition(binding.kind === "graph-binding" && object(binding.value) && isRef(binding.value.graph),
      "stage_summary_graph_binding_invalid", `[${bindingRef.id}@${bindingRef.revision}/graph] The saved graph binding is incomplete`);
    exact(store, binding.value.graph);
    fullGraph = binding.value.graph;
  } else limitations.push("Полный graph Ref не сохранён в доказательствах приёмки; показан только точный layer Ref");
  const currentLayerRecord = store.get<SavedLayer>(layerRef.id);
  if (currentLayerRecord) requireCondition(currentLayerRecord.kind === "graph-layer" && object(currentLayerRecord.value)
    && object(currentLayerRecord.value.projection), "stage_summary_layer_invalid",
  `[${currentLayerRecord.id}@${currentLayerRecord.revision}/projection] The current L1 comparison is malformed`);
  const currentGraphRecord = store.get<unknown>(`graph:${project}`);
  if (currentGraphRecord) requireCondition(currentGraphRecord.kind === "graph", "stage_summary_graph_invalid",
    `[${currentGraphRecord.id}@${currentGraphRecord.revision}] The current graph comparison is malformed`);
  const currentLayer = currentLayerRecord ? reference(currentLayerRecord) : null;
  const currentGraph = currentGraphRecord ? reference(currentGraphRecord) : null;
  return { ref: layerRef, projection: located(layerRef, "/projection", projection), journeys, fullGraph, currentGraph, currentLayer,
    acceptedPathChanged: currentLayerRecord ? !same(currentLayerRecord.value.projection, projection) : null,
    fullGraphChanged: fullGraph && currentGraph ? !same(fullGraph, currentGraph) : null, limitations };
}

function stageMaterial(stage: SummaryStructuredStage, fields: Map<string, FieldRead>, layer: SummaryLayer | null): SummaryStageMaterial {
  const field = (name: string): SummaryField | null => fields.get(name)?.summary ?? null;
  if (stage === "concept") return { stage, overview: ["audience", "outcome", "acceptance"].map(field)
    .filter((item): item is SummaryField => item !== null), sections: field("conceptSections") };
  if (stage === "operation-map") {
    requireCondition(layer, "stage_summary_layer_missing", "[/content/graph] Accepted operation-map has no exact L1 layer Ref");
    return { stage, legacyJourney: field("journey"), requirements: field("operationRequirements"),
      design: field("mapDesign"), layer };
  }
  if (stage === "specification") return { stage, behavior: field("behavior"), constraints: field("constraints"),
    behaviorContracts: field("behaviorContracts") };
  return { stage, features: field("features"), preparation: field("featurePreparation") };
}

function readStructuredAccepted(store: Store, artifact: Revision<StageArtifact>, current: Revision<StageArtifact> | null,
  stage: SummaryStructuredStage): SummaryStructuredAccepted {
  requireCondition(artifact.kind === "stage" && artifact.value.projectId && artifact.value.stage === stage
    && artifact.value.status === "accepted" && Array.isArray(artifact.value.inputs) && artifact.value.inputs.length === 1
    && Array.isArray(artifact.value.proofs), "stage_summary_artifact_invalid",
  `[${artifact.id}] The accepted ${stage} artifact is malformed or foreign`);
  const content = artifact.value.content as unknown as StageContent;
  requireCondition(object(content) && isRef(content.draft) && object(content.fields)
    && Object.hasOwn(content, "graph") && Object.keys(content).sort().join(",") === "draft,fields,graph",
  "stage_summary_artifact_invalid", `[${artifact.id}/content] The accepted ${stage} content has an invalid shape`);
  requireCondition(stage === "operation-map" ? isRef(content.graph) : content.graph === null,
    stage === "operation-map" ? "stage_summary_layer_missing" : "stage_summary_artifact_invalid",
    `[${artifact.id}@${artifact.revision}/content/graph] The accepted ${stage} graph binding is invalid`);
  const proofs = new AcceptedProofs(store, artifact), prior = predecessor(stage), input = artifact.value.inputs[0]!;
  requireCondition(prior && input.id === stageId(artifact.value.projectId, prior), "stage_summary_input_invalid",
    `[${artifact.id}/inputs/0] The accepted ${stage} prerequisite has the wrong address`);
  const prerequisite = proofs.require<StageArtifact>(input, `${stage} prerequisite`);
  requireCondition(prerequisite.kind === "stage" && prerequisite.value.projectId === artifact.value.projectId
    && prerequisite.value.stage === prior && prerequisite.value.status === "accepted", "stage_summary_input_invalid",
  `[${input.id}@${input.revision}] The accepted ${stage} prerequisite is not an accepted ${prior} stage`);
  const draft = proofs.require<DiscoveryDraft>(content.draft, `${stage} draft`), version = draft.value.contractVersion ?? 1;
  const consumer = STAGES[STAGES.indexOf(stage) + 1];
  requireCondition(draft.kind === "discovery-draft" && draft.value.projectId === artifact.value.projectId
    && draft.value.stage === stage && draft.value.level === "R0" && draft.value.consumer === consumer
    && [1, 2, 3, 4, 5].includes(version) && same(draft.value.fields, content.fields)
    && draft.value.inputs.some(ref => same(ref, input)), "stage_summary_draft_invalid",
  `[${draft.id}] The accepted ${stage} draft is malformed, foreign or differs from the stage`);
  const expected = requirements(version, stage), specs = draft.value.questions.map(id => proofs.head<Question>(id, `${stage} question`).value.spec);
  requireCondition(same(specs, expected), "stage_summary_contract_invalid",
    `[${draft.id}] The accepted ${stage} questions do not match contract version ${version}`);
  const fields = new Map(expected.map(spec => [spec.field, readAcceptedField(proofs, artifact, draft, spec.field)]));
  const limitations: string[] = [];
  if (stage === "concept" && !fields.has("conceptSections")) limitations.push(`conceptSections отсутствует в contractVersion ${version}`);
  if (stage === "operation-map") {
    if (!fields.has("operationRequirements")) limitations.push(`operationRequirements отсутствует в contractVersion ${version}`);
    if (!fields.has("mapDesign")) limitations.push(`mapDesign отсутствует в contractVersion ${version}`);
  }
  if (stage === "specification" && !fields.has("behaviorContracts")) limitations.push(`behaviorContracts отсутствует в contractVersion ${version}`);
  if (stage === "features" && !fields.has("featurePreparation")) limitations.push(`featurePreparation отсутствует в contractVersion ${version}`);
  const layer = stage === "operation-map" ? layerSummary(store, proofs, artifact.value.projectId, content.graph as Ref) : null;
  if (layer) limitations.push(...layer.limitations);
  return { state: current && same(reference(current), reference(artifact)) ? "accepted" : "previously_accepted",
    artifact: reference(artifact), draft: reference(draft), contractVersion: version,
    fields: [...fields.values()].map(item => item.summary), material: stageMaterial(stage, fields, layer), limitations };
}

function candidateRun(store: Store, project: string, draft: Revision<DiscoveryDraft>): SummaryRun | null {
  const run = store.get<ResearchRun>(`research-run:${hashJson([project, draft.id])}`);
  if (!run) return null;
  requireCondition(run.kind === "research-run" && run.value.projectId === project && run.value.draftId === draft.id,
    "stage_summary_run_invalid", `[${run.id}] The linked research run is foreign or malformed`);
  const owner = run.value.ownerQuestion;
  requireCondition(run.value.status !== "needs_owner" || owner !== null, "stage_summary_run_invalid",
    `[${run.id}] A needs-owner run has no addressed owner question`);
  let door: string | null = run.value.status === "paused" ? "research-stage" : null;
  let questionRef: Ref | null = null;
  if (run.value.status === "needs_owner" && owner) {
    const question = store.get<Question>(owner.question);
    requireCondition(question?.kind === "question" && question.value.projectId === project
      && question.value.draftId === draft.id && draft.value.questions.includes(question.id),
    "stage_summary_run_invalid", `[${run.id}] The owner pause names no question of this draft`);
    door = question.value.spec.kind === "fact" ? "answer-fact" : "answer-decision";
    questionRef = reference(question);
  }
  const missing = owner ? [owner.reason] : run.value.error ? [run.value.error] : [];
  return { ref: reference(run), status: run.value.status, pauseCode: run.value.pauseCode ?? null,
    error: run.value.error, question: questionRef, missing, door };
}

function readCandidate(store: Store, project: string, draft: Revision<DiscoveryDraft>): SummaryCandidate {
  const records: Revision<Question>[] = [];
  let questionFailure: SummaryFailure | null = null;
  for (const id of draft.value.questions) {
    try {
      const question = store.get<Question>(id);
      requireCondition(question?.kind === "question" && question.value.projectId === project && question.value.draftId === draft.id,
        "stage_summary_question_invalid", `[${id}] The candidate question is missing or foreign`);
      records.push(question);
    } catch (error) { questionFailure = candidateFailure(error, records); break; }
  }
  const questions = records.map(question =>
    ({ ref: reference(question), field: question.value.spec.field, status: question.value.status }));
  if (questionFailure) return { draft: reference(draft), contractVersion: draft.value.contractVersion ?? 1,
    state: "researching", researchPlan: null, report: null, verdict: null,
    questionFailure, admission: null, outcomeFailure: null, researchFailure: null, choiceHistoryFailure: null,
    runFailure: null, reason: null, reasonAddress: null, conditions: [], ownerChoices: [], decisions: [],
    questions, run: null, door: null };
  let outcome: ReturnType<typeof discoveryOutcome> | null = null, admission: SummaryFailure | null = null;
  try { outcome = discoveryOutcome(store, draft); }
  catch (error) { admission = candidateFailure(error, records); }
  const research = candidateResearch(store, project, draft, records);
  const conditions: SummaryLocated[] = [], ownerChoices: SummaryOwnerChoice[] = [], decisions: SummaryChoiceDecision[] = [];
  let outcomeFailure: SummaryFailure | null = null, choiceHistoryFailure: SummaryFailure | null = null;
  let reasonAddress: SummaryAddress | null = null;
  if (outcome?.verdict) {
    try {
      const verdictQuestion = records.find(question => question.value.spec.field === "verdict");
      const verdict = exact<{ projectId: string; question: string; value: Json }>(store, outcome.verdict);
      requireCondition(verdict.kind === "research-answer" && verdictQuestion
        && verdict.value.projectId === project && verdict.value.question === verdictQuestion.id
        && object(verdict.value.value) && Array.isArray(verdict.value.value.conditions),
      "stage_summary_outcome_invalid", `[${outcome.verdict.id}] The current verdict is missing, foreign or malformed`);
      const raw = verdict.value.value.conditions as Json[];
      const locate = (value: Json): { value: Json; address: SummaryAddress } => {
        const matching = raw.map((item, index) => same(item, value) ? index : -1).filter(index => index >= 0);
        requireCondition(matching.length === 1, "stage_summary_outcome_invalid",
          `[${outcome.verdict!.id}] A current condition has no unique address in its verdict`);
        return { value, address: address(outcome.verdict!, `/value/conditions/${matching[0]}`) };
      };
      conditions.push(...outcome.conditions.map(locate));
      ownerChoices.push(...outcome.ownerChoices.map(choice => {
        const found = raw.findIndex(item => object(item) && item.id === choice.conditionId);
        requireCondition(found >= 0, "stage_summary_outcome_invalid",
          `[${outcome.verdict!.id}] An owner choice has no condition in its verdict`);
        return { ...choice, address: address(outcome.verdict!, `/value/conditions/${found}`) };
      }));
      reasonAddress = address(outcome.verdict, "/value/reason");
      for (const condition of raw) {
        if (!object(condition) || condition.kind !== "owner_choice" || typeof condition.id !== "string"
          || !Array.isArray(condition.options)) continue;
        const saved = store.get<DiscoveryConditionDecision>(discoveryDecisionId(project, draft.id, outcome.verdict, condition.id));
        if (!saved) continue;
        const option = condition.options.find(item => object(item) && item.optionId === saved.value.optionId) as DiscoveryChoiceOption | undefined;
        requireCondition(saved.kind === "discovery-condition-decision" && saved.revision === 1
          && saved.value.contract === "discovery-condition-decision/v1" && saved.value.projectId === project
          && saved.value.draftId === draft.id && same(saved.value.verdictRef, outcome.verdict)
          && saved.value.conditionId === condition.id && typeof saved.value.actor === "string" && saved.value.actor.trim().length > 0
          && option !== undefined, "stage_summary_choice_invalid",
        `[${saved.id}] The saved Discovery choice is foreign or does not select an offered option`);
        decisions.push({ ref: reference(saved), round: null, verdict: outcome.verdict, conditionId: saved.value.conditionId,
          optionId: saved.value.optionId, option: option.label, choice: option.choice, actor: saved.value.actor });
      }
    } catch (error) {
      conditions.length = 0; ownerChoices.length = 0; decisions.length = 0; reasonAddress = null;
      outcomeFailure = candidateFailure(error, records);
    }
  }
  const verdictQuestion = records.find(question => question.value.spec.field === "verdict");
  if ((draft.value.contractVersion ?? 1) === 5 && verdictQuestion) {
    const before = records.slice(0, records.indexOf(verdictQuestion));
    if (before.every(question => question.value.status === "answered")) {
      try {
        const history = discoveryContext(store, draft, verdictQuestion).context?.ownerDecisions ?? [];
        for (const round of history) for (const item of round.decisions) {
          const saved = exact<DiscoveryConditionDecision>(store, item.ref);
          requireCondition(saved.kind === "discovery-condition-decision" && same(saved.value, item.value)
            && typeof item.option?.label === "string" && (item.option.choice === "accept" || item.option.choice === "decline"),
          "stage_summary_choice_invalid", `[${item.ref.id}] The saved Discovery choice history is incomplete or foreign`);
          if (!decisions.some(decision => same(decision.ref, item.ref))) decisions.push({ ref: item.ref, round: round.round,
            verdict: round.verdict.ref, conditionId: item.value.conditionId, optionId: item.value.optionId,
            option: item.option.label, choice: item.option.choice, actor: item.value.actor });
        }
      } catch (error) { choiceHistoryFailure = candidateFailure(error, records); }
    }
  }
  let run: SummaryRun | null = null, runFailure: SummaryFailure | null = null;
  try { run = candidateRun(store, project, draft); }
  catch (error) { runFailure = candidateFailure(error, records); }
  const door = ownerChoices.length ? "answer-decision:discovery-condition"
    : verdictQuestion?.value.status === "open" && decisions.length ? "research-stage"
    : run?.door ?? (admission || outcome?.state === "researching" ? "research-stage" : null);
  return { draft: reference(draft), contractVersion: draft.value.contractVersion ?? 1,
    state: outcome?.state ?? "researching", researchPlan: research.researchPlan,
    report: research.report, verdict: research.verdict, questionFailure, admission, outcomeFailure,
    researchFailure: research.failure, choiceHistoryFailure, runFailure,
    reason: outcome?.reason ?? null, reasonAddress,
    conditions, ownerChoices, decisions, questions, run, door };
}

function currentEntryRefs(store: Store, project: string): Ref[] {
  const binding = store.get<EarlyStageInput>(`early-stage-input:${project}`);
  if (!binding) return [];
  requireCondition(binding.kind === "early-stage-input" && binding.value?.contract === "early-stage-input/v1"
    && binding.value.projectId === project && binding.value.actor === "driver:verbatim"
    && isRef(binding.value.project) && isRef(binding.value.source),
  "instruction_binding_invalid", `[${binding.id}] The current early-stage input is incomplete or foreign`);
  return uniqueRefs([binding.value.project, binding.value.source, reference(binding)]);
}

function acceptedQuestionsMoved(store: Store, artifact: Revision<StageArtifact>,
  draft: Revision<DiscoveryDraft>): boolean {
  const content = artifact.value.content as unknown as StageContent;
  if (!isRef(content.draft) || !same(content.draft, reference(draft))) return false;
  const proofs = new Map(artifact.value.proofs.map(ref => [ref.id, ref]));
  return draft.value.questions.some(id => {
    const saved = proofs.get(id), current = store.get<Question>(id);
    return !saved || !current || !same(saved, reference(current));
  });
}

function selectDiscoveryCandidate(store: Store, project: string, explicit: string | undefined,
  history: Revision<StageArtifact>[], accepted: Revision<StageArtifact> | null, current: Revision<StageArtifact> | null): { selected: Revision<DiscoveryDraft> | null; candidates: Ref[] } {
  const entryRefs = currentEntryRefs(store, project);
  const valid = (draft: Revision<DiscoveryDraft> | null): draft is Revision<DiscoveryDraft> => Boolean(draft
    && draft.kind === "discovery-draft" && draft.value.projectId === project && draft.value.stage === "discovery"
    && draft.value.level === "R0" && draft.value.consumer === "concept" && [4, 5].includes(draft.value.contractVersion ?? 1)
    && same(draft.value.inputs, entryRefs));
  if (explicit !== undefined) {
    const draft = store.get<DiscoveryDraft>(explicit);
    requireCondition(valid(draft), "stage_summary_draft_foreign", `[${explicit}] The selected candidate is missing or belongs to another project or stage`);
    return { selected: draft, candidates: [] };
  }
  const currentContent = current?.value.status === "draft" ? current.value.content as unknown as StageContent : null;
  if (currentContent && isRef(currentContent.draft)) {
    const draft = exact<DiscoveryDraft>(store, currentContent.draft);
    if (valid(draft)) return { selected: draft, candidates: [] };
  }
  const bound = history.map(item => (item.value.content as unknown as { draft?: unknown }).draft).filter(isRef);
  const drafts = store.list<DiscoveryDraft>("discovery-draft").filter(valid).filter(draft => {
    if (accepted && draft.id === (accepted.value.content as unknown as StageContent).draft.id
      && (!same(reference(draft), (accepted.value.content as unknown as StageContent).draft)
        || acceptedQuestionsMoved(store, accepted, draft))) return true;
    return !bound.some(ref => same(ref, reference(draft)));
  });
  return drafts.length === 1 ? { selected: drafts[0]!, candidates: [] }
    : { selected: null, candidates: drafts.map(reference) };
}

function readStructuredCandidate(store: Store, project: string, stage: SummaryStructuredStage,
  draft: Revision<DiscoveryDraft>, current: Revision<StageArtifact> | null): SummaryStructuredCandidate {
  const records: Revision<Question>[] = [];
  let questionFailure: SummaryFailure | null = null;
  for (const id of draft.value.questions) {
    try {
      const question = store.get<Question>(id);
      requireCondition(question?.kind === "question" && question.value.projectId === project && question.value.draftId === draft.id,
        "stage_summary_question_invalid", `[${id}] The candidate question is missing or foreign`);
      records.push(question);
    } catch (error) { questionFailure = candidateFailure(error, records); break; }
  }
  let upstreamFailure: SummaryFailure | null = null;
  try {
    const prior = predecessor(stage), expectedId = prior ? stageId(project, prior) : null;
    const inputs = Array.isArray(draft.value.inputs) && expectedId
      ? draft.value.inputs.filter(ref => isRef(ref) && ref.id === expectedId) : [];
    requireCondition(prior && inputs.length === 1, "stage_summary_input_invalid",
      `[${draft.id}/inputs] The ${stage} candidate has no unique saved ${prior ?? "upstream"} prerequisite`);
    const prerequisite = exact<StageArtifact>(store, inputs[0]!, "stage_summary_input_invalid");
    requireCondition(prerequisite.kind === "stage" && prerequisite.value.projectId === project
      && prerequisite.value.stage === prior && prerequisite.value.status === "accepted",
    "stage_summary_input_invalid", `[${inputs[0]!.id}@${inputs[0]!.revision}] The saved candidate prerequisite is not an accepted ${prior}`);
  } catch (error) { upstreamFailure = candidateFailure(error, records); }
  let graphFailure: SummaryFailure | null = null;
  if (stage === "operation-map" && current?.value.status === "draft") {
    const content = current.value.content as unknown as Partial<StageContent>;
    if (isRef(content.draft) && same(content.draft, reference(draft))) try {
      requireCondition(isRef(content.graph), "stage_summary_layer_missing",
        `[${current.id}@${current.revision}/content/graph] The operation-map candidate has no exact L1 layer Ref`);
      requireCondition(content.graph.id === `graph-layer:${project}:1`, "stage_summary_layer_invalid",
        `[${content.graph.id}@${content.graph.revision}/projection] The operation-map candidate does not name its L1 layer`);
      const layer = exact<SavedLayer>(store, content.graph, "stage_summary_layer_invalid");
      requireCondition(layer.kind === "graph-layer" && object(layer.value) && object(layer.value.projection)
        && layer.value.projection.level === 1, "stage_summary_layer_invalid",
      `[${content.graph.id}@${content.graph.revision}/projection] The operation-map candidate L1 projection is incomplete`);
    } catch (error) { graphFailure = candidateFailure(error, records); }
  }
  let run: SummaryRun | null = null, runFailure: SummaryFailure | null = null;
  try { run = candidateRun(store, project, draft); }
  catch (error) { runFailure = candidateFailure(error, records); }
  const draftRef = reference(draft);
  return { draft: draftRef, contractVersion: draft.value.contractVersion ?? 1, state: run?.status ?? "ready",
    fields: Object.entries(draft.value.fields).map(([field, value]) =>
      ({ field, ...located(draftRef, `/fields/${pointerToken(field)}`, value) })),
    questions: records.map(question =>
      ({ ref: reference(question), field: question.value.spec.field, status: question.value.status })),
    upstreamFailure, questionFailure, graphFailure, run, runFailure,
    door: run?.door ?? (runFailure ? null : "research-stage") };
}

function selectStructuredCandidate(store: Store, project: string, stage: SummaryStructuredStage, explicit: string | undefined,
  history: Revision<StageArtifact>[], accepted: Revision<StageArtifact> | null, current: Revision<StageArtifact> | null):
  { selected: Revision<DiscoveryDraft> | null; candidates: Ref[] } {
  const consumer = STAGES[STAGES.indexOf(stage) + 1], prior = predecessor(stage), priorId = prior ? stageId(project, prior) : null;
  const valid = (draft: Revision<DiscoveryDraft> | null): draft is Revision<DiscoveryDraft> => Boolean(draft
    && draft.kind === "discovery-draft" && draft.value.projectId === project && draft.value.stage === stage
    && draft.value.level === "R0" && draft.value.consumer === consumer && [1, 2, 3, 4, 5].includes(draft.value.contractVersion ?? 1)
    && priorId !== null && Array.isArray(draft.value.inputs)
    && draft.value.inputs.some(ref => isRef(ref) && ref.id === priorId));
  if (explicit !== undefined) {
    const draft = store.get<DiscoveryDraft>(explicit);
    requireCondition(valid(draft), "stage_summary_draft_foreign",
      `[${explicit}] The selected candidate is missing or belongs to another project or stage`);
    return { selected: draft, candidates: [] };
  }
  const currentContent = current?.value.status === "draft" ? current.value.content as unknown as StageContent : null;
  if (currentContent && isRef(currentContent.draft)) {
    const draft = store.get<DiscoveryDraft>(currentContent.draft.id, currentContent.draft.revision);
    if (draft?.hash === currentContent.draft.hash && valid(draft)) return { selected: draft, candidates: [] };
  }
  const bound = history.map(item => (item.value.content as unknown as { draft?: unknown }).draft).filter(isRef);
  const drafts = store.list<DiscoveryDraft>("discovery-draft").filter(valid).filter(draft => {
    if (accepted && draft.id === (accepted.value.content as unknown as StageContent).draft.id
      && (!same(reference(draft), (accepted.value.content as unknown as StageContent).draft)
        || acceptedQuestionsMoved(store, accepted, draft))) return true;
    return !bound.some(ref => same(ref, reference(draft)));
  });
  return drafts.length === 1 ? { selected: drafts[0]!, candidates: [] }
    : { selected: null, candidates: drafts.map(reference) };
}

export function stageSummary(store: Store, project: string, stage: "discovery", draftId?: string): DiscoveryStageSummary;
export function stageSummary(store: Store, project: string, stage: SummaryStructuredStage, draftId?: string): StructuredStageSummary;
export function stageSummary(store: Store, project: string, stage: Stage, draftId?: string): StageSummary;
export function stageSummary(store: Store, project: string, stage: Stage, draftId?: string): StageSummary {
  requireCondition(UPSTREAM_STAGES.includes(stage as UpstreamStage), "stage_summary_unavailable",
    `Readable summary for ${stage} is not connected yet`);
  const stamp = store.changeStamp();
  const projectRecord = store.get<{ id: string }>(`project:${project}`);
  requireCondition(projectRecord?.kind === "project" && projectRecord.value.id === project,
    "project_missing", "Project does not exist");
  const id = stageId(project, stage), history = store.history<StageArtifact>(id);
  const current = store.get<StageArtifact>(id);
  if (current) requireCondition(current.kind === "stage" && current.value.projectId === project && current.value.stage === stage,
    "stage_summary_artifact_invalid", `[${id}] The current stage artifact is foreign or malformed`);
  const accepted = [...history].reverse().find(item => item.kind === "stage" && item.value.projectId === project
    && item.value.stage === stage && item.value.status === "accepted") ?? null;
  let result: StageSummary;
  if (stage === "discovery") {
    const selection = selectDiscoveryCandidate(store, project, draftId, history, accepted, current);
    result = { contract: "stage-summary/discovery/v1", project, stage, currentStage: current ? reference(current) : null,
      accepted: accepted ? readAccepted(store, accepted, current) : null,
      candidate: selection.selected ? readCandidate(store, project, selection.selected) : null,
      candidates: selection.candidates };
  } else {
    const structuredStage = stage as SummaryStructuredStage;
    const selection = selectStructuredCandidate(store, project, structuredStage, draftId, history, accepted, current);
    result = { contract: "stage-summary/upstream/v1", project, stage: structuredStage,
      currentStage: current ? reference(current) : null,
      accepted: accepted ? readStructuredAccepted(store, accepted, current, structuredStage) : null,
      candidate: selection.selected ? readStructuredCandidate(store, project, structuredStage, selection.selected, current) : null,
      candidates: selection.candidates };
  }
  requireCondition(store.changeStamp() === stamp, "input_stale",
    `[${id}] Stage summary inputs changed during the read; refresh the summary`);
  return result;
}

const valueText = (value: Json): string => typeof value === "string" ? value : `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
const addressText = (value: SummaryAddress): string => `${value.record.id}@${value.record.revision}${value.pointer}`;
function appendResearchReport(lines: string[], heading: string, report: SummaryResearchReport): void {
  lines.push(heading, "", `Основание: ${addressText(report.field.address)}`, `Вариант: ${report.variant}`);
  for (const result of report.results) {
    lines.push(`- ${result.id} [${addressText(result.address)}]`, `  - вопрос: ${result.question}`, `  - вывод: ${result.conclusion}`);
    for (const citation of result.citations) lines.push(`  - источник ${citation.ref.id}@${citation.ref.revision}: ${citation.quote}`,
      `    предел: ${citation.proofLimit}${citation.finalUrl ? `; URL: ${citation.finalUrl}; снимок: ${citation.fetchedAt}` : ""}`);
    for (const limit of result.limits) lines.push(`  - предел вывода: ${limit}`);
  }
  for (const question of report.openQuestions) lines.push(`- неизвестное [${addressText(question.address)}]: ${canonical(question.value)}`);
  for (const constraint of report.constraints) lines.push(`- ограничение отчёта [${addressText(constraint.address)}]: ${canonical(constraint.value)}`);
  lines.push("");
}
function appendResearchVerdict(lines: string[], heading: string, verdict: SummaryResearchVerdict): void {
  lines.push(heading, "", `Основание: ${addressText(verdict.field.address)}`,
    `Исход: ${verdict.outcome}`, `Вариант: ${verdict.variant}`, `Причина: ${verdict.reason}`,
    ...verdict.bases.map(item => `Основание [${addressText(item.address)}]: ${canonical(item.value)}`),
    ...verdict.conditions.map(item => `Условие [${addressText(item.address)}]: ${canonical(item.value)}`), "");
}

const STAGE_TITLES: Record<SummaryStructuredStage, string> = {
  concept: "Концепция", "operation-map": "L1 · Карта операций", specification: "Спецификация", features: "Фичи",
};

function renderStructuredStageSummary(summary: StructuredStageSummary): string {
  const lines = [`# ${STAGE_TITLES[summary.stage]}`, ""];
  if (!summary.accepted) lines.push("Принятый результат: ещё не принято.", "");
  else {
    const accepted = summary.accepted;
    lines.push(accepted.state === "accepted" ? "Принятый результат." : "Ранее принято; сейчас пересмотрено.",
      `Артефакт: ${accepted.artifact.id}@${accepted.artifact.revision}`,
      `Черновик: ${accepted.draft.id}@${accepted.draft.revision}`, `Договор: v${accepted.contractVersion}`, "");
    for (const field of accepted.fields) lines.push(`## ${field.field}`, "",
      `${field.origin.label}${field.origin.author ? ` (${field.origin.author})` : ""} [${addressText(field.address)}]`,
      valueText(field.value), "");
    if (accepted.material.stage === "operation-map") {
      const layer = accepted.material.layer;
      lines.push("## Точная принятая L1", "", `Layer: ${layer.ref.id}@${layer.ref.revision}`,
        `Принятый путь отличается от текущей L1: ${layer.acceptedPathChanged === null ? "сравнение недоступно" : layer.acceptedPathChanged ? "да" : "нет"}`,
        `Полный graph Ref при приёмке: ${layer.fullGraph ? `${layer.fullGraph.id}@${layer.fullGraph.revision}` : "не доказан сохранённой связью"}`,
        `Текущий graph Ref: ${layer.currentGraph ? `${layer.currentGraph.id}@${layer.currentGraph.revision}` : "нет"}`, "");
      for (const journey of layer.journeys) {
        const actor = journey.actor.value as unknown as { id?: string; role?: string };
        const outcome = journey.outcome.value as unknown as { id?: string };
        lines.push(`### Путь ${journey.id} [${addressText(journey.address)}]`, "",
          `Участник: ${actor.id ?? "?"}${actor.role ? ` — ${actor.role}` : ""} [${addressText(journey.actor.address)}]`,
          `Вход: ${String(journey.entry.value)}`,
          `Узлы: ${journey.nodes.map(item => (item.value as unknown as { id?: string }).id ?? "?").join(" → ")}`,
          `Результат: ${outcome.id ?? "?"}; terminal=${journey.terminal} [${addressText(journey.outcome.address)}]`);
        for (const transition of journey.transitions)
          lines.push(`- переход [${addressText(transition.address)}]: ${canonical(transition.value)}`);
        lines.push("");
      }
      lines.push("### Полная сохранённая проекция L1", "", valueText(layer.projection.value), "");
    }
    for (const limitation of accepted.limitations) lines.push(`Ограничение истории: ${limitation}`);
    if (accepted.limitations.length) lines.push("");
  }
  if (summary.candidate) {
    const candidate = summary.candidate;
    lines.push("## Текущий кандидат", "", `Черновик: ${candidate.draft.id}@${candidate.draft.revision}`,
      `Исход: ${candidate.state === "ready" ? "готов к исследованию" : candidate.state}`);
    if (candidate.upstreamFailure) lines.push(`Отказ чтения основания кандидата ${candidate.upstreamFailure.code}: ${candidate.upstreamFailure.message}`);
    if (candidate.questionFailure) lines.push(`Отказ чтения вопросов кандидата ${candidate.questionFailure.code}${candidate.questionFailure.question
      ? ` [${candidate.questionFailure.question.id}@${candidate.questionFailure.question.revision}]` : ""}: ${candidate.questionFailure.message}`);
    if (candidate.graphFailure) lines.push(`Отказ чтения L1 кандидата ${candidate.graphFailure.code}: ${candidate.graphFailure.message}`);
    if (candidate.runFailure) lines.push(`Отказ чтения запуска кандидата ${candidate.runFailure.code}${candidate.runFailure.question
      ? ` [${candidate.runFailure.question.id}@${candidate.runFailure.question.revision}]` : ""}: ${candidate.runFailure.message}`);
    for (const field of candidate.fields) lines.push(`- ${field.field} [${addressText(field.address)}]: ${canonical(field.value)}`);
    for (const question of candidate.questions)
      lines.push(`- вопрос ${question.field}: ${question.status}; ${question.ref.id}@${question.ref.revision}`);
    if (candidate.run) lines.push(`Запуск: ${candidate.run.ref.id}@${candidate.run.ref.revision}; состояние: ${candidate.run.status}`,
      `Код паузы: ${candidate.run.pauseCode ?? "нет"}`,
      `Вопрос: ${candidate.run.question ? `${candidate.run.question.id}@${candidate.run.question.revision}` : "нет"}`,
      `Причина остановки: ${candidate.run.error ?? "нет"}`,
      ...candidate.run.missing.map(item => `Недостаёт: ${item}`));
    lines.push(`Дверь: ${candidate.door ?? "не зафиксирована"}`);
    lines.push("");
  } else if (summary.candidates.length) lines.push("## Текущий кандидат", "", "Кандидат неоднозначен; укажите draftId:",
    ...summary.candidates.map(ref => `- ${ref.id}@${ref.revision}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStageSummary(summary: StageSummary): string {
  if (summary.stage !== "discovery") return renderStructuredStageSummary(summary);
  const lines = ["# Discovery", ""];
  if (!summary.accepted) lines.push("Принятый результат: ещё не принято.", "");
  else {
    const accepted = summary.accepted;
    lines.push(accepted.state === "accepted" ? "Принятый результат." : "Ранее принято; сейчас пересмотрено.",
      `Артефакт: ${accepted.artifact.id}@${accepted.artifact.revision}`, `Договор: v${accepted.contractVersion}`, "",
      "## Поручение", "", `brief — ${accepted.instruction.brief.origin.label} [${addressText(accepted.instruction.brief.address)}]: ${valueText(accepted.instruction.brief.value)}`,
      `objective — ${accepted.instruction.objective.origin.label} [${addressText(accepted.instruction.objective.address)}]: ${valueText(accepted.instruction.objective.value)}`, "");
    if (accepted.researchPlan) lines.push("## Рамка и план исследования", "",
      `Основание: ${addressText(accepted.researchPlan.address)}`, valueText(accepted.researchPlan.value), "");
    if (accepted.report) appendResearchReport(lines, "## Результаты исследования", accepted.report);
    if (accepted.verdict) appendResearchVerdict(lines, "## Вердикт", accepted.verdict);
    if (accepted.preparation) lines.push("## Подготовка", "", `Основание: ${addressText(accepted.preparation.address)}`,
      valueText(accepted.preparation.value), "");
    for (const limitation of accepted.limitations) lines.push(`Ограничение истории: ${limitation}`);
    if (accepted.limitations.length) lines.push("");
  }
  if (summary.candidate) {
    const candidate = summary.candidate;
    lines.push("## Текущее исследование", "", `Черновик: ${candidate.draft.id}@${candidate.draft.revision}`,
      `Исход: ${candidate.state === "researching" ? "исследование не завершено" : candidate.state}`);
    if (candidate.admission) lines.push(`Отказ допуска ${candidate.admission.code}${candidate.admission.question
      ? ` [${candidate.admission.question.id}@${candidate.admission.question.revision}]` : ""}: ${candidate.admission.message}`);
    if (candidate.questionFailure) lines.push(`Отказ чтения вопросов кандидата ${candidate.questionFailure.code}${candidate.questionFailure.question
      ? ` [${candidate.questionFailure.question.id}@${candidate.questionFailure.question.revision}]` : ""}: ${candidate.questionFailure.message}`);
    if (candidate.outcomeFailure) lines.push(`Отказ чтения исхода кандидата ${candidate.outcomeFailure.code}${candidate.outcomeFailure.question
      ? ` [${candidate.outcomeFailure.question.id}@${candidate.outcomeFailure.question.revision}]` : ""}: ${candidate.outcomeFailure.message}`);
    if (candidate.researchFailure) lines.push(`Отказ чтения сохранённого исследования ${candidate.researchFailure.code}${candidate.researchFailure.question
      ? ` [${candidate.researchFailure.question.id}@${candidate.researchFailure.question.revision}]` : ""}: ${candidate.researchFailure.message}`);
    if (candidate.choiceHistoryFailure) lines.push(`Отказ чтения истории выбора ${candidate.choiceHistoryFailure.code}${candidate.choiceHistoryFailure.question
      ? ` [${candidate.choiceHistoryFailure.question.id}@${candidate.choiceHistoryFailure.question.revision}]` : ""}: ${candidate.choiceHistoryFailure.message}`);
    if (candidate.runFailure) lines.push(`Отказ чтения запуска кандидата ${candidate.runFailure.code}${candidate.runFailure.question
      ? ` [${candidate.runFailure.question.id}@${candidate.runFailure.question.revision}]` : ""}: ${candidate.runFailure.message}`);
    if (candidate.reason) lines.push(`Причина${candidate.reasonAddress ? ` [${addressText(candidate.reasonAddress)}]` : ""}: ${candidate.reason}`);
    if (candidate.researchPlan) lines.push("### Сохранённая рамка и план исследования", "",
      `Основание: ${addressText(candidate.researchPlan.address)}`, valueText(candidate.researchPlan.value), "");
    if (candidate.report) appendResearchReport(lines, "### Сохранённые результаты исследования", candidate.report);
    if (candidate.verdict) appendResearchVerdict(lines, "### Сохранённый вердикт", candidate.verdict);
    for (const question of candidate.questions) lines.push(`- вопрос ${question.field}: ${question.status}; ${question.ref.id}@${question.ref.revision}`);
    for (const condition of candidate.conditions) lines.push(`- условие [${addressText(condition.address)}]: ${canonical(condition.value)}`);
    for (const choice of candidate.ownerChoices) lines.push(`- требуется выбор [${addressText(choice.address)}]: ${choice.conditionId}`,
      ...choice.options.map(option => `  - ${option.optionId}: ${option.label} (${option.choice})`));
    for (const decision of candidate.decisions) lines.push(`- записанный выбор ${decision.conditionId}: ${decision.optionId} — ${decision.option}; ${decision.ref.id}@${decision.ref.revision}`);
    lines.push(`Дверь: ${candidate.door ?? "не зафиксирована"}`);
    if (candidate.run) lines.push(`Запуск: ${candidate.run.ref.id}@${candidate.run.ref.revision}; состояние: ${candidate.run.status}`,
      `Код паузы: ${candidate.run.pauseCode ?? "нет"}`,
      `Вопрос: ${candidate.run.question ? `${candidate.run.question.id}@${candidate.run.question.revision}` : "нет"}`,
      `Причина остановки: ${candidate.run.error ?? "нет"}`,
      ...candidate.run.missing.map(item => `Недостаёт: ${item}`));
    lines.push("");
  } else if (summary.candidates.length) {
    lines.push("## Текущее исследование", "", "Кандидат неоднозначен; укажите draftId:",
      ...summary.candidates.map(ref => `- ${ref.id}@${ref.revision}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { Store, type Revision } from "../storage/store.js";
import { Evidence, type Observation, type Selector } from "../evidence/evidence.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, STAGES, isRef, uniqueRefs, type Ref, type Stage, type Finding, type GateResult } from "../pipeline/contracts.js";
import type { Graph } from "../graph/model.js";
import { REQUIREMENTS, RESEARCH_CONTRACT_VERSION, type UpstreamStage } from "./requirements.js";
import type { ResearchAnswer, ResearchAssessment } from "./research-model.js";
import { deriveFields, type Derivation } from "./derived-draft.js";
import { resolveResearchBasis } from '../graph/research-basis.js';
import type { TechnicalReport } from '../graph/research-contracts.js';
import { Environments } from '../runtime/environment.js';
import { obligationEvidenceFindings } from '../graph/obligation-evidence.js';

export type ResearchLevel = "R0" | "R1" | "R2" | "R3";
export interface FieldSpec { field: string; kind: "fact" | "decision" | "design"; prompt: string; risk: string; schema: Json; proof?: "extraction" | "assessment";
  basisContract?: 'typed-v1';
  obligationContract?: 'evidence-v1';
  obligations?: { id: string; target: string; field: string; consumer: string;
    assignment?: import('../graph/obligation-policy.js').ObligationAssignment }[];
  targets?: { target: string; field: string; consumer: string; question: string }[] }
export interface DiscoveryDraft {
  projectId: string; createdAt: number; stage: Stage; level: ResearchLevel; consumer: string;
  fields: Record<string, Json>; questions: string[];
  inputs: Ref[];
  contractVersion?: number;
  basisContract?: 'typed-v1';
  obligationContract?: 'evidence-v1';
  derivations?: Derivation[];
}
export interface Question {
  projectId: string; draftId: string; stage: Stage; level: ResearchLevel; consumer: string;
  spec: FieldSpec; beforeHash: string; status: "open" | "answered" | "unresolved";
  answer: Ref | null;
}
export interface Decision { projectId: string; actor: string; question: string; value: Json }
export interface Fact { projectId: string; question: string; observation: Observation }

const ajv = new Ajv({ strict: true, allowUnionTypes: true });
export class Discovery {
  readonly evidence: Evidence;
  constructor(private readonly store: Store) { this.evidence = new Evidence(store); }
  forStage(projectId: string, stage: UpstreamStage, consumer: string, inputs: Ref[] = []): Revision<DiscoveryDraft> {
    requireCondition(Object.hasOwn(REQUIREMENTS, stage), "stage_contract_missing", "No research contract for this stage");
    return this.create(projectId, stage, "R0", consumer, REQUIREMENTS[stage], inputs, RESEARCH_CONTRACT_VERSION);
  }
  create(projectId: string, stage: Stage, level: ResearchLevel, consumer: string, specs: FieldSpec[], inputs: Ref[] = [], contractVersion?: number): Revision<DiscoveryDraft> {
    requireCondition(STAGES.includes(stage) && ["R0", "R1", "R2", "R3"].includes(level) && typeof consumer === "string"
      && consumer.trim() && Array.isArray(specs) && specs.length > 0,
      "question_unbound", "Discovery needs a level, consumer and explicit questions");
    const graph = this.store.get<Graph>(`graph:${projectId}`);
    requireCondition(STAGES.includes(consumer as Stage) || (graph?.kind === "graph" && graph.value.nodes.some(node => node.id === consumer)),
      "consumer_missing", "The research consumer must be an existing stage or graph node");
    requireCondition(specs.every(spec => spec && typeof spec === "object" && typeof spec.field === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(spec.field)
      && !["constructor", "prototype", "__proto__"].includes(spec.field)
      && ["fact", "decision", "design"].includes(spec.kind) && (spec.proof === undefined || ["extraction", "assessment"].includes(spec.proof))
      && typeof spec.prompt === "string" && spec.prompt.trim()
      && typeof spec.risk === "string" && spec.risk.trim() && Object.hasOwn(spec, "schema"))
      && new Set(specs.map(spec => spec.field)).size === specs.length, "question_invalid", "Questions need unique fields, a type, prompt and risk");
    for (const spec of specs) ajv.compile(spec.schema as object);
    const typedBasis = specs.some(spec => spec.basisContract !== undefined);
    requireCondition(!typedBasis || (stage === 'om-g2' && level === 'R2' && consumer === 'compilation'
      && specs.every(spec => spec.basisContract === 'typed-v1')), 'research_contract_mismatch', 'Typed technical bases require a complete R2 question set');
    const obligationEvidence = specs.some(spec => spec.obligationContract !== undefined);
    requireCondition(!obligationEvidence || (typedBasis && specs.every(spec => spec.obligationContract === 'evidence-v1')),
      'research_contract_mismatch', 'Obligation evidence rules apply to the complete typed R2 draft');
    const id = `discovery:${projectId}:${randomUUID()}`;
    const questions = specs.map(() => `question:${projectId}:${randomUUID()}`);
    requireCondition(Array.isArray(inputs) && inputs.every(isRef), "research_context_invalid", "Research context must contain exact input references");
    const draft: DiscoveryDraft = { projectId, createdAt: Date.now(), stage, level, consumer, inputs: uniqueRefs(inputs), ...(contractVersion === undefined ? {} : { contractVersion }),
      ...(typedBasis ? { basisContract: 'typed-v1' as const } : {}), ...(obligationEvidence ? { obligationContract: 'evidence-v1' as const } : {}),
      fields: Object.fromEntries(specs.map(spec => [spec.field, null])), questions };
    const writes = [{ id, kind: "discovery-draft", expected: 0, value: draft },
      ...specs.map((spec, i) => ({ id: questions[i]!, kind: "question", expected: 0,
        value: { projectId, draftId: id, stage, level, consumer, spec, beforeHash: hashJson(null), status: "open", answer: null } satisfies Question }))];
    return this.store.writeMany<DiscoveryDraft>(writes, inputs)[0]!;
  }
  #question(id: string, expected: number): Revision<Question> {
    const question = this.store.get<Question>(id);
    requireCondition(question && question.kind === "question" && question.revision === expected,
      "question_stale", "Question is missing or changed");
    requireCondition(question.value.status !== "answered", "question_already_answered", "Reopen the question before changing an answer");
    return question;
  }
  #answer(question: Revision<Question>, value: Json, answer: Decision | Fact | ResearchAnswer, kind: "decision" | "design" | "fact" | "research-answer", guards: Ref[]): Revision<DiscoveryDraft> {
    const q = question.value; const draft = this.store.get<DiscoveryDraft>(q.draftId);
    requireCondition(draft && draft.kind === "discovery-draft" && draft.value.projectId === q.projectId
      && draft.value.questions.includes(question.id), "question_unbound", "Question must belong to this draft");
    requireCondition(hashJson(draft.value.fields[q.spec.field]) === q.beforeHash,
      "target_stale", "The target field changed since this question was issued");
    const validate = ajv.compile(q.spec.schema as object);
    requireCondition(validate(value), "answer_invalid", "The answer does not satisfy the field contract");
    const id = `${kind}:${q.projectId}:${randomUUID()}`;
    const answerRef: Ref = { id, revision: 1, hash: hashJson(answer) };
    return this.store.writeMany<DiscoveryDraft>([
      { id: draft.id, kind: draft.kind, expected: draft.revision, value: { ...draft.value, fields: { ...draft.value.fields, [q.spec.field]: value } } },
      { id, kind, expected: 0, value: answer },
      { id: question.id, kind: question.kind, expected: question.revision, value: { ...q, status: "answered", answer: answerRef } },
    ], [...guards, ...draft.value.inputs, reference(question), reference(draft)])[0]!;
  }
  decision(id: string, expected: number, actor: string, value: Json): Revision<DiscoveryDraft> {
    const question = this.#question(id, expected);
    requireCondition(question.value.spec.kind === "decision" || question.value.spec.kind === "design", "fact_requires_evidence", "An owner's choice cannot confirm a factual question");
    requireCondition(typeof actor === "string" && actor.trim(), "actor_missing", "Decision needs an owner identity");
    return this.#answer(question, value, { projectId: question.value.projectId, actor, question: id, value }, question.value.spec.kind, []);
  }
  fact(id: string, expected: number, source: Ref, selector: Selector): Revision<DiscoveryDraft> {
    const question = this.#question(id, expected);
    requireCondition(question.value.spec.kind === "fact", "decision_required", "A preference requires an owner decision");
    requireCondition(question.value.spec.proof !== "assessment", "research_assessment_required", "This factual question needs research and an assessment, not just copied source bytes");
    const observation = this.evidence.observe(question.value.projectId, source, selector);
    return this.#answer(question, observation.value, { projectId: question.value.projectId, question: id, observation }, "fact", [source]);
  }
  researched(id: string, expected: number, assessmentRef: Ref): Revision<DiscoveryDraft> {
    const question = this.#question(id, expected);
    const assessment = this.store.get<ResearchAssessment>(assessmentRef.id);
    requireCondition(assessment?.kind === "research-assessment" && assessment.hash === assessmentRef.hash && assessment.revision === assessmentRef.revision
      && assessment.value.verdict === "supported" && assessment.value.projectId === question.value.projectId
      && canonical(assessment.value.question) === canonical(reference(question))
      && assessment.value.researcher !== assessment.value.assessor && assessment.value.observations.length > 0
      && assessment.value.observations.every(item => this.evidence.verify(item)), "research_not_supported", "An exact supported assessment with current evidence is required");
    const draft = this.store.get<DiscoveryDraft>(question.value.draftId);
    requireCondition(question.value.spec.basisContract === draft?.value.basisContract && question.value.spec.obligationContract === draft?.value.obligationContract,
      'research_contract_mismatch', 'Answer must retain the basis contract of its draft');
    if (question.value.spec.basisContract === 'typed-v1') {
      requireCondition(ajv.compile(question.value.spec.schema as object)(assessment.value.value), 'answer_invalid', 'Typed answer must match its recorded schema');
      const result = resolveResearchBasis(this.store, question.value.projectId, assessment.value.value as unknown as TechnicalReport,
        assessment.value.observations, new Environments(this.store).effective(question.value.projectId).root, question.value.spec.field);
      requireCondition(result.findings.length === 0 && Array.isArray(assessment.value.bases)
        && canonical(result.bases) === canonical(assessment.value.bases), 'research_basis_invalid', 'Assessment must retain the exact machine-resolved bases and their proof limits');
      const obligations = obligationEvidenceFindings(question.value.spec,assessment.value.value as unknown as TechnicalReport,assessment.value.observations);
      if (obligations.length) throw new EngineError('research_obligation_evidence_invalid','An assessed value still must satisfy its assigned knowledge kind',obligations);
    }
    const answer: ResearchAnswer = { projectId: question.value.projectId, question: id, assessment: assessmentRef, value: assessment.value.value };
    return this.#answer(question, answer.value, answer, "research-answer", [assessmentRef, assessment.value.environment,
      ...assessment.value.observations.map(item => item.source)]);
  }
  observations(questionId: string): Observation[] {
    const question = this.store.get<Question>(questionId);
    requireCondition(question?.kind === "question" && question.value.status === "answered" && question.value.answer,
      "question_unresolved", "The question has no accepted evidence");
    const answer = this.store.get<Fact | ResearchAnswer | Decision>(question.value.answer.id);
    requireCondition(answer?.hash === question.value.answer.hash && answer.revision === question.value.answer.revision,
      "answer_foreign", "The question's exact answer is unavailable");
    if (answer.kind === "fact") return [(answer.value as Fact).observation];
    if (answer.kind === "research-answer") {
      const ref = (answer.value as ResearchAnswer).assessment;
      const assessment = this.store.get<ResearchAssessment>(ref.id);
      requireCondition(assessment?.kind === "research-assessment" && assessment.hash === ref.hash && assessment.revision === ref.revision
        && assessment.value.verdict === "supported", "research_not_supported", "Research evidence has no supported assessment");
      return assessment.value.observations;
    }
    return [];
  }
  unresolved(id: string, expected: number): void {
    const question = this.#question(id, expected);
    this.store.write({ id, kind: "question", expected, value: { ...question.value, status: "unresolved" } });
  }
  reopen(id: string, expected: number): Revision<Question> {
    const q = this.store.get<Question>(id);
    requireCondition(q && q.kind === "question" && q.revision === expected, "question_stale", "Question changed");
    const draft = this.store.get<DiscoveryDraft>(q.value.draftId);
    requireCondition(draft, "draft_missing", "Question target is missing");
    return this.store.writeMany<Question>([{ id, kind: "question", expected,
      value: { ...q.value, beforeHash: hashJson(draft.value.fields[q.value.spec.field]), status: "open", answer: null } }], [reference(draft)])[0]!;
  }
  gate(projectId: string, draftRef: Ref): GateResult {
    requireCondition(isRef(draftRef), "discovery_ref_invalid", "Discovery needs a versioned draft reference");
    const findings: Finding[] = []; const guards: Ref[] = [];
    const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
    const draft = this.store.get<DiscoveryDraft>(draftRef.id);
    if (!draft || draft.kind !== "discovery-draft" || draft.value.projectId !== projectId
      || draft.revision !== draftRef.revision || draft.hash !== draftRef.hash) {
      return { findings: [{ code: "discovery_stale", target: draftRef.id, message: "Discovery draft is missing, foreign or changed" }], guards };
    }
    guards.push(reference(draft));
    if (draft.value.derivations) {
      try {
        if (draft.value.questions.length || canonical(deriveFields(this.store, projectId, draft.value.derivations)) !== canonical(draft.value.fields))
          fail("derivation_conflict", draft.id, "Derived research must exactly preserve its accepted source fields");
        guards.push(...draft.value.derivations.map(entry => entry.source));
      } catch { fail("derivation_stale", draft.id, "The accepted source of derived research changed or is unavailable"); }
    }
    for (const input of uniqueRefs(draft.value.inputs)) {
      const current = this.store.get(input.id);
      if (!current || current.revision !== input.revision || current.hash !== input.hash) fail("research_context_stale", input.id, "Research was performed against a different input version");
      else guards.push(reference(current));
    }
    for (const id of draft.value.questions) {
      const question = this.store.get<Question>(id);
      if (!question || question.kind !== "question" || question.value.projectId !== projectId || question.value.draftId !== draft.id
        || question.value.status !== "answered" || !question.value.answer) { fail("question_unresolved", id, "Question has no accepted answer"); continue; }
      guards.push(reference(question));
      const ref = question.value.answer; const answer = this.store.get<Decision | Fact | ResearchAnswer>(ref.id);
      if (!answer || answer.hash !== ref.hash || answer.revision !== ref.revision || answer.value.projectId !== projectId || answer.value.question !== id
        || (answer.kind !== question.value.spec.kind && answer.kind !== "research-answer")) { fail("answer_foreign", id, "Answer binding is invalid"); continue; }
      guards.push(reference(answer));
      let value: Json;
      if (answer.kind === "research-answer") {
        const research = answer.value as ResearchAnswer;
        const assessment = this.store.get<ResearchAssessment>(research.assessment.id);
        const issued = assessment ? this.store.get<Question>(assessment.value.question.id, assessment.value.question.revision) : null;
        if (assessment?.kind !== "research-assessment" || assessment.hash !== research.assessment.hash
          || assessment.revision !== research.assessment.revision || assessment.value.verdict !== "supported"
          || issued?.hash !== assessment.value.question.hash || issued.id !== id
          || canonical(issued.value.spec) !== canonical(question.value.spec) || assessment.value.researcher === assessment.value.assessor
          || assessment.value.observations.length === 0 || !assessment.value.observations.every(item => this.evidence.verify(item))
          || canonical(assessment.value.value) !== canonical(research.value)) {
          fail("research_evidence_stale", id, "Research assessment or its supporting sources are stale or foreign"); continue;
        }
        guards.push(reference(assessment), ...assessment.value.observations.map(item => item.source)); value = research.value;
      } else if (answer.kind === "fact") {
        const observation = (answer.value as Fact).observation;
        if (!this.evidence.verify(observation)) { fail("evidence_stale", id, "Source evidence is missing or changed"); continue; }
        guards.push(observation.source); value = observation.value;
      } else {
        const decision = answer.value as Decision;
        if (!decision.actor?.trim()) { fail("actor_missing", id, "Decision owner is missing"); continue; }
        value = decision.value;
      }
      if (canonical(value) !== canonical(draft.value.fields[question.value.spec.field])) fail("answer_target_mismatch", id, "The answer no longer matches its target field");
    }
    return { findings, guards: uniqueRefs(guards) };
  }
}

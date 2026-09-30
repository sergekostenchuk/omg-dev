import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
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
import { Environments, uniqueTransactionGuards } from '../runtime/environment.js';
import { obligationEvidenceFindings } from '../graph/obligation-evidence.js';
import { collectRuntimeEvidence, runtimeEvidenceDependencies } from '../graph/runtime-evidence.js';
import { readResearchAssessmentAt, assessmentBindingId } from './research-assessment.js';
import { readResearchConsumerTurn, readResearchAcceptanceBinding, pinnedLayerDeltaStore } from './response-recovery.js';
import { researchAction, projectAcceptanceBinding, acceptanceBindingId,
  type ManagedResearchTurn, type AcceptedPaidAnswerInputs } from './research-consumer-transition.js';
import { expandLayerDelta } from './layer-delta.js';

export type ResearchLevel = "R0" | "R1" | "R2" | "R3";
export interface FieldSpec { field: string; kind: "fact" | "decision" | "design"; prompt: string; risk: string; schema: Json; proof?: "extraction" | "assessment";
  layerAssembly?: import('../graph/layer-assembly.js').LayerAssembly;
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
/** D8.4e: the proven managed provenance of one acceptance (see #managedAcceptance). */
interface ManagedAcceptance {
  turn: Ref; pending: Ref; intent: Ref; assessment: Revision<ResearchAssessment>; assessmentProof: Ref;
  action: unknown; expandedProposal?: unknown;
}
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
  #answer(question: Revision<Question>, value: Json, answer: Decision | Fact | ResearchAnswer, kind: "decision" | "design" | "fact" | "research-answer", guards: TransactionGuard[],
    managed?: ManagedAcceptance): Revision<DiscoveryDraft> {
    const q = question.value; const draft = this.store.get<DiscoveryDraft>(q.draftId);
    requireCondition(draft && draft.kind === "discovery-draft" && draft.value.projectId === q.projectId
      && draft.value.questions.includes(question.id), "question_unbound", "Question must belong to this draft");
    requireCondition(hashJson(draft.value.fields[q.spec.field]) === q.beforeHash,
      "target_stale", "The target field changed since this question was issued");
    const validate = ajv.compile(q.spec.schema as object);
    requireCondition(validate(value), "answer_invalid", "The answer does not satisfy the field contract");
    const id = `${kind}:${q.projectId}:${randomUUID()}`;
    const answerRef: Ref = { id, revision: 1, hash: hashJson(answer) };
    const draftAfter = { ...draft.value, fields: { ...draft.value.fields, [q.spec.field]: value } };
    const questionAfter = { ...q, status: "answered" as const, answer: answerRef };
    const writes: Write[] = [
      { id: draft.id, kind: draft.kind, expected: draft.revision, value: draftAfter },
      { id, kind, expected: 0, value: answer },
      { id: question.id, kind: question.kind, expected: question.revision, value: questionAfter },
    ];
    const bindingGuards: TransactionGuard[] = [];
    if (managed) {
      // D8.4e: K is derived from the PREPARED writes by the shared projection
      // — the future draft, answer and question revisions are named before
      // they exist — and rides the same transaction. Its current-state guards
      // are the consumed pending revision P, the managed proof B and the
      // supported assessment R; expected:0 is the absence of any earlier K.
      requireCondition(kind === "research-answer", "research_acceptance_binding_invalid",
        "Only a paid research answer takes an acceptance record");
      const inputs: AcceptedPaidAnswerInputs = { projectId: q.projectId,
        draftBefore: draft,
        draftAfter: { id: draft.id, kind: draft.kind, revision: draft.revision + 1, hash: hashJson(draftAfter), value: draftAfter },
        questionBefore: question,
        questionAfter: { id: question.id, kind: question.kind, revision: question.revision + 1,
          hash: hashJson(questionAfter), value: questionAfter },
        answer: { id, kind, revision: 1, hash: answerRef.hash, value: answer as ResearchAnswer },
        assessment: managed.assessment, action: managed.action,
        ...(managed.expandedProposal !== undefined ? { expandedProposal: managed.expandedProposal } : {}) };
      const binding = projectAcceptanceBinding(inputs, { turn: managed.turn, pending: managed.pending,
        intent: managed.intent, assessmentProof: managed.assessmentProof });
      writes.push({ id: acceptanceBindingId(q.projectId, managed.turn.id), kind: "research-acceptance-binding",
        expected: 0, value: binding });
      // O@1 and I are proven immutable revisions (their heads lawfully move
      // on); the current-state guards are P, B and R plus the CAS of the
      // three records and the absence of K.
      bindingGuards.push(managed.pending, managed.assessmentProof, reference(managed.assessment));
    }
    return this.store.writeMany<DiscoveryDraft>(writes,
      uniqueTransactionGuards([...guards, ...draft.value.inputs, reference(question), reference(draft), ...bindingGuards]))[0]!;
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
  /** Accept a supported assessment as the question's answer. `managedPending`
   * (D8.4e) is the exact pending revision P of the managed paid turn whose
   * answer this is: the managed runner branches must pass it. Standalone and
   * reuse callers keep the three-record acceptance without a record.
   *
   * D8.4e круг 3 (№2259, table W1–W6): the managed attempt is ONE wrapped
   * unit. After the initial check of the acceptance record at the turn's
   * address, the whole attempt — question, current bases and admission,
   * provenance preparation, the four-record write — runs under one handler.
   * Any TYPED refusal of that path re-reads the record before it is passed
   * on: W1 no record → the original refusal as is; W2 a record proven wholly
   * with the same P, R and question revision → the winner's saved result,
   * no write, no spend, no admission on today's bases; W3 a proven record of
   * another acceptance → research_acceptance_binding_invalid; W4 a damaged
   * or unprovable record → the common reader's refusal as is, with address;
   * W5 a non-typed exception → thrown as is, the record is not read; W6
   * success — the write's expected:0 is the final protection of K. */
  researched(id: string, expected: number, assessmentRef: Ref, managedPending?: Ref): Revision<DiscoveryDraft> {
    if (managedPending === undefined) return this.#acceptSupported(id, expected, assessmentRef);
    requireCondition(isRef(managedPending), 'research_acceptance_binding_invalid',
      'A managed acceptance needs the exact pending paid turn');
    const won = this.#winningAcceptance(id, expected, assessmentRef, managedPending);
    if (won) return won;
    try { return this.#acceptSupported(id, expected, assessmentRef, managedPending); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      const winner = this.#winningAcceptance(id, expected, assessmentRef, managedPending);
      if (winner) return winner;
      throw error;
    }
  }
  /** The acceptance attempt on today's bases: the open question at its
   * expected revision, the exact supported assessment with current evidence,
   * the draft's contracts, the typed basis and runtime provenance, then the
   * write — with K when the attempt is managed. */
  #acceptSupported(id: string, expected: number, assessmentRef: Ref, managedPending?: Ref): Revision<DiscoveryDraft> {
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
    const runtimeGuards:TransactionGuard[]=[];
    if (question.value.spec.basisContract === 'typed-v1') {
      requireCondition(ajv.compile(question.value.spec.schema as object)(assessment.value.value), 'answer_invalid', 'Typed answer must match its recorded schema');
      const effective = new Environments(this.store).effective(question.value.projectId);
      runtimeGuards.push(reference(effective.environment), ...effective.guards, ...effective.admissionGuards);
      const result = resolveResearchBasis(this.store, question.value.projectId, assessment.value.value as unknown as TechnicalReport,
        assessment.value.observations, effective.root, question.value.spec.field);
      requireCondition(result.findings.length === 0 && Array.isArray(assessment.value.bases)
        && canonical(result.bases) === canonical(assessment.value.bases), 'research_basis_invalid', 'Assessment must retain the exact machine-resolved bases and their proof limits');
      const runtime = collectRuntimeEvidence(this.store,question.value.projectId,question.value.spec,assessment.value.value as unknown as TechnicalReport,assessment.value.observations);
      requireCondition(canonical(runtime.proofs)===canonical(assessment.value.runtimeProofs??[]),'research_runtime_evidence_invalid','Runtime provenance must remain exact at acceptance');
      runtimeGuards.push(...runtime.guards, ...runtime.admissionGuards);
      const obligations = obligationEvidenceFindings(question.value.spec,assessment.value.value as unknown as TechnicalReport,assessment.value.observations,runtime.proofs);
      if (obligations.length) throw new EngineError('research_obligation_evidence_invalid','An assessed value still must satisfy its assigned knowledge kind',obligations);
    }
    const answer: ResearchAnswer = { projectId: question.value.projectId, question: id, assessment: assessmentRef, value: assessment.value.value };
    const guards: TransactionGuard[] = [assessmentRef, assessment.value.environment,
      ...assessment.value.observations.map(item => item.source), ...runtimeGuards];
    if (managedPending === undefined) return this.#answer(question, answer.value, answer, "research-answer", guards);
    const managed = this.#managedAcceptance(question, assessment, managedPending);
    return this.#answer(question, answer.value, answer, "research-answer", guards, managed);
  }
  /** D8.4e (№2259 W2–W4): the acceptance already made for this exact managed
   * turn, read at the turn's own address and proven wholly from its own K —
   * or null when no record exists there (W1). The same pending revision P,
   * the same supported assessment R and the same question revision return
   * the winner's saved draft (W2); a proven record of another acceptance is
   * the addressed refusal (W3); a damaged or unprovable record is the common
   * reader's refusal as thrown (W4). Nothing here depends on today's Source,
   * files or heads: a made acceptance is historical. */
  #winningAcceptance(questionId: string, expected: number, assessmentRef: Ref,
    managedPending: Ref): Revision<DiscoveryDraft> | null {
    const head = this.store.get<Question>(questionId);
    if (head?.kind !== 'question') return null;
    const proven = readResearchAcceptanceBinding(this.store, head.value.projectId, managedPending.id);
    if (!proven) return null;
    requireCondition(canonical(reference(proven.pending)) === canonical(managedPending)
      && canonical(reference(proven.assessment)) === canonical(assessmentRef)
      && proven.inputs.questionBefore.id === questionId && proven.inputs.questionBefore.revision === expected,
    'research_acceptance_binding_invalid',
    `[${managedPending.id}] The paid turn already carries another acceptance than this one`);
    const draftAfter = this.store.get<DiscoveryDraft>(proven.inputs.draftAfter.id, proven.inputs.draftAfter.revision);
    requireCondition(draftAfter && canonical(reference(draftAfter)) === canonical(reference(proven.inputs.draftAfter)),
      'research_acceptance_binding_invalid', `[${managedPending.id}] The winning acceptance lost its exact accepted draft`);
    return draftAfter;
  }
  /** D8.4e boundary 1: prove the managed provenance of an acceptance before
   * any write — P is the pending managed turn of this exact question (its
   * reader proves O@1, I and every earlier revision), R is proven under its
   * managed proof B whose pending revision precedes P on the same lawful
   * chain. An existing K is never rewritten: the write's expected:0 refuses
   * it and the winner is then proven by #winningAcceptance (W2–W4). */
  #managedAcceptance(question: Revision<Question>, assessment: Revision<ResearchAssessment>,
    managedPending: Ref): ManagedAcceptance {
    const projectId = question.value.projectId;
    requireCondition(isRef(managedPending), 'research_acceptance_binding_invalid',
      'A managed acceptance needs the exact pending paid turn');
    const rawPending = this.store.get<ManagedResearchTurn>(managedPending.id, managedPending.revision);
    requireCondition(rawPending?.kind === 'research-turn' && rawPending.value.status === 'pending'
      && canonical(reference(rawPending)) === canonical(managedPending),
    'research_acceptance_binding_invalid', `[${managedPending.id}] The managed acceptance needs a pending revision of the paid turn`);
    const pending = readResearchConsumerTurn(this.store, managedPending) as Revision<ManagedResearchTurn>;
    const first = this.store.get<ManagedResearchTurn>(pending.id, 1);
    requireCondition(first?.kind === 'research-turn' && hashJson(first.value) === first.hash
      && pending.value.contract === 'research-consumer-turn/v1' && pending.value.status === 'pending'
      && canonical(pending.value.question) === canonical(reference(question))
      && canonical(first.value.consumerIntent) === canonical(pending.value.consumerIntent),
    'research_acceptance_binding_invalid', `[${managedPending.id}] The pending paid turn does not carry this exact question`);
    const action = researchAction(pending.value.action);
    requireCondition((action.action === 'answer' || action.action === 'answer_delta') && action.question === question.id,
      'research_acceptance_binding_invalid', `[${managedPending.id}] The pending paid turn is not an answer to this question`);
    const checked = readResearchAssessmentAt(this.store, projectId, pending.id, reference(assessment));
    requireCondition(canonical(reference(checked)) === canonical(reference(assessment)),
      'research_assessment_binding_invalid', `[${managedPending.id}] The managed assessment is not the accepted one`);
    const proof = this.store.get<{ pending: Ref }>(assessmentBindingId(projectId, pending.id));
    requireCondition(proof && isRef(proof.value.pending) && proof.value.pending.id === pending.id
      && proof.value.pending.revision <= pending.revision,
    'research_assessment_binding_invalid', `[${managedPending.id}] The managed assessment proof precedes no lawful pending chain`);
    for (let revision = proof.value.pending.revision; revision < pending.revision; revision += 1) {
      const step = this.store.get<ManagedResearchTurn>(pending.id, revision);
      requireCondition(step?.kind === 'research-turn' && step.value.status === 'pending'
        && (revision !== proof.value.pending.revision || canonical(reference(step)) === canonical(proof.value.pending)),
      'research_assessment_binding_invalid', `[${managedPending.id}] The assessed pending revision is not on this turn's pending chain`);
    }
    const expandedProposal = action.action === 'answer_delta'
      ? expandLayerDelta(pinnedLayerDeltaStore(this.store, action),
        this.store.get<DiscoveryDraft>(question.value.draftId)!, question, action)
      : undefined;
    return { turn: reference(first), pending: reference(pending), intent: pending.value.consumerIntent,
      assessment, assessmentProof: reference(proof), action,
      ...(expandedProposal !== undefined ? { expandedProposal } : {}) };
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
        for(const dependency of runtimeEvidenceDependencies(assessment.value.runtimeProofs??[])){
          const current=this.store.get(dependency.id);
          if(!current||current.hash!==dependency.hash||current.revision!==dependency.revision)
            fail('research_evidence_stale',id,'A runtime evidence dependency changed');
          else guards.push(dependency);
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

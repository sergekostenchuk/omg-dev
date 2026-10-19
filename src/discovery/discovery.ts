import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";
import { Store, storeObserved, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { Evidence, sourceIsCurrent, type Observation, type Selector, type Source } from "../evidence/evidence.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { requireCondition, EngineError } from "../errors.js";
import { reference, STAGES, isRef, uniqueRefs, type Ref, type Stage, type Finding, type GateResult,
  type StageExternalCheck } from "../pipeline/contracts.js";
import type { Graph } from "../graph/model.js";
import { NEXT_CONTRACT_ERA, REQUIREMENTS, producerContractEra, producerRequirements, type ProducerPolicy, type UpstreamStage } from "./requirements.js";
import { checkV7FieldAnswer, DISCOVERY_ACCEPTANCE_ACT_KIND, DISCOVERY_ACCEPTANCE_ACT_CONTRACT, discoveryAcceptanceActId, type DiscoveryAcceptanceAct } from "./v7-contracts.js";
import { provenAcceptance } from "./claim-address.js";
import { proveIssuedAnswer, savedAcceptanceAct } from "./projection-reader.js";
import type { ResearchAnswer, ResearchAssessment } from "./research-model.js";
import { deriveFields, type Derivation } from "./derived-draft.js";
import { resolveResearchBasis } from '../graph/research-basis.js';
import type { TechnicalReport } from '../graph/research-contracts.js';
import { Environments, uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { obligationEvidenceFindings } from '../graph/obligation-evidence.js';
import { collectRuntimeEvidence, runtimeEvidenceDependencies } from '../graph/runtime-evidence.js';
import { readResearchAssessmentAt, assessmentBindingId, directAssessmentBasis } from './research-assessment.js';
import { readResearchConsumerTurn, readResearchAcceptanceBinding, pinnedLayerDeltaStore } from './response-recovery.js';
import { researchAction, projectAcceptanceBinding, acceptanceBindingId, managedAnswerId, managedAnswerTurn,
  type ManagedResearchTurn, type AcceptedPaidAnswerInputs, type ResearchAcceptanceBinding } from './research-consumer-transition.js';
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
/** G4a (пул K ред.2, №6215 п.2): the committed closure of one draft revision's accepted prefix —
 * a separate record written in the same batch as the draft revision it closes (the draft's own bytes
 * never change), at the deterministic address of `discoveryPrefixClosureId`. It names every head the
 * gate compares: the draft's inputs, each question's head and its accepted answer chain — the exact
 * answer, its assessment, the v7 acceptance act — every `observation.source` of every era (web and
 * owner-document sources included) and the runtime evidence dependencies. File sources are
 * additionally declared as external `source` checks re-executed on every read — their bytes live
 * outside the store. Question-only writers (`reopen`, `unresolved`) keep the same closure key: the
 * saved question head no longer matches, so the read falls back to the full pass — a stale field
 * never stands for an accepted answer. A managed research answer is closed through the saved read
 * set of its own K proof: K@1 and every head the proof reads become head guards, every exact
 * non-head revision it reads (the turn's pending chain, the intent chain, B/M/session and the
 * replayed read proof) is pinned by presence and hash — a rebound assessment's source chain is
 * unbounded, so a rebound stays on the full pass by design. */
export const DISCOVERY_PREFIX_CLOSURE_KIND = "discovery-prefix-closure";
export const DISCOVERY_PREFIX_CLOSURE_CONTRACT = "discovery-prefix-closure/v1";
export function discoveryPrefixClosureId(draftId: string, revision: number): string {
  return `${DISCOVERY_PREFIX_CLOSURE_KIND}:${draftId}:${revision}`;
}
/** G4a (№6284): the complete read set the managed K proof performed when the prefix was closed.
 * `heads`/`absentHeads` — every head read (K@1 included) and every head absence, re-verified as
 * guards on the closed path: a head the proof stood on moving is the only lawful change that can
 * alter its outcome. `pinned`/`absentPinned` — the saved manifest of the exact revisions the proof
 * read and missed (the pending/intent/turn chains, B, M, session, the replayed read proof): exact
 * revisions are immutable, so the closed path does not re-verify them row by row (№6348 G4a-01) —
 * each entity an exact read missed is snapshotted into the head requirements instead, and the
 * physical integrity of immutable rows is the offline checker's (om-fsck) domain. */
interface ManagedPrefixProof {
  heads: Ref[]; absentHeads: string[]; pinned: Ref[]; absentPinned: { id: string; revision: number }[];
}
interface PrefixClosureAnswer {
  answer: Ref; assessment: Ref | null; binding: Ref | null; act: Ref | null;
  sources: Ref[]; runtimeDependencies: Ref[];
  /** Snapshot entry material (решение №6253): stored at acceptance so the closed read never
   * decodes old question/answer/assessment bodies to serve the accepted prefix. */
  field: string; kind: string; value: Json; observations: number;
  managed?: ManagedPrefixProof;
}
interface PrefixClosureQuestion { question: Ref; answer: PrefixClosureAnswer | null }
/** G4a→G4b (решение оркестратора №6253/6254): the accepted prefix a checked closure proves — one
 * entry per answered question in draft order, carried in the closure record itself. */
export interface AcceptedPrefixEntry {
  question: Ref; field: string; status: "answered"; kind: string; answer: Ref; value: Json;
  assessment: Ref | null; observations: number;
}
export interface AcceptedPrefixSnapshot {
  contract: "discovery-prefix/v1"; draft: Ref; closure: Ref; entries: AcceptedPrefixEntry[];
}
declare module "../pipeline/contracts.js" {
  interface GateResult { prefix?: AcceptedPrefixSnapshot }
}
export interface DiscoveryPrefixClosure {
  contract: typeof DISCOVERY_PREFIX_CLOSURE_CONTRACT;
  projectId: string; draftId: string; draft: Ref;
  inputs: Ref[]; derivations: Ref[];
  questions: PrefixClosureQuestion[];
  external: StageExternalCheck[];
}
/** Structural form of a saved closure — every field the closed read and the acceptance-time
 * inheritance trust without decoding the records the entry refs name. `questionIds`, when given,
 * pins the questions array to the draft's own order. */
const shapeManagedProof = (managed: unknown): managed is ManagedPrefixProof =>
  managed !== null && typeof managed === "object" && !Array.isArray(managed)
  && Array.isArray((managed as ManagedPrefixProof).heads) && (managed as ManagedPrefixProof).heads.every(isRef)
  && Array.isArray((managed as ManagedPrefixProof).absentHeads)
  && (managed as ManagedPrefixProof).absentHeads.every(id => typeof id === "string")
  && Array.isArray((managed as ManagedPrefixProof).pinned) && (managed as ManagedPrefixProof).pinned.every(isRef)
  && Array.isArray((managed as ManagedPrefixProof).absentPinned)
  && (managed as ManagedPrefixProof).absentPinned.every(ref => ref !== null && typeof ref === "object"
    && typeof (ref as { id: unknown }).id === "string"
    && Number.isSafeInteger((ref as { revision: unknown }).revision));
const shapeClosureAnswer = (entry: unknown): entry is PrefixClosureAnswer =>
  entry !== null && typeof entry === "object" && !Array.isArray(entry)
  && isRef((entry as PrefixClosureAnswer).answer)
  && ((entry as PrefixClosureAnswer).assessment === null || isRef((entry as PrefixClosureAnswer).assessment))
  && ((entry as PrefixClosureAnswer).binding === null || isRef((entry as PrefixClosureAnswer).binding))
  && ((entry as PrefixClosureAnswer).act === null || isRef((entry as PrefixClosureAnswer).act))
  && Array.isArray((entry as PrefixClosureAnswer).sources) && (entry as PrefixClosureAnswer).sources.every(isRef)
  && Array.isArray((entry as PrefixClosureAnswer).runtimeDependencies)
  && (entry as PrefixClosureAnswer).runtimeDependencies.every(isRef)
  && typeof (entry as PrefixClosureAnswer).field === "string"
  && typeof (entry as PrefixClosureAnswer).kind === "string"
  && Number.isSafeInteger((entry as PrefixClosureAnswer).observations)
  && (entry as PrefixClosureAnswer).observations >= 0
  && ((entry as PrefixClosureAnswer).managed === undefined || shapeManagedProof((entry as PrefixClosureAnswer).managed));
const shapeClosure = (value: unknown, projectId: string, draftId: string,
  questionIds: readonly string[] | null): value is DiscoveryPrefixClosure =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (value as DiscoveryPrefixClosure).contract === DISCOVERY_PREFIX_CLOSURE_CONTRACT
  && (value as DiscoveryPrefixClosure).projectId === projectId
  && (value as DiscoveryPrefixClosure).draftId === draftId
  && isRef((value as DiscoveryPrefixClosure).draft)
  && Array.isArray((value as DiscoveryPrefixClosure).inputs) && (value as DiscoveryPrefixClosure).inputs.every(isRef)
  && Array.isArray((value as DiscoveryPrefixClosure).derivations)
  && (value as DiscoveryPrefixClosure).derivations.every(isRef)
  && Array.isArray((value as DiscoveryPrefixClosure).questions)
  && (questionIds === null || (value as DiscoveryPrefixClosure).questions.length === questionIds.length)
  && (value as DiscoveryPrefixClosure).questions.every((entry, index) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && isRef((entry as PrefixClosureQuestion).question)
    && (questionIds === null || (entry as PrefixClosureQuestion).question.id === questionIds[index])
    && ((entry as PrefixClosureQuestion).answer === null
      || shapeClosureAnswer((entry as PrefixClosureQuestion).answer)))
  && Array.isArray((value as DiscoveryPrefixClosure).external)
  && (value as DiscoveryPrefixClosure).external.every(check => check !== null
    && typeof check === "object" && !Array.isArray(check)
    && (check as { kind?: unknown }).kind === "source" && isRef((check as { ref?: unknown }).ref));

const ajv = new Ajv({ strict: true, allowUnionTypes: true });
export class Discovery {
  readonly evidence: Evidence;
  constructor(private readonly store: Store) { this.evidence = new Evidence(store); }
  forStage(projectId: string, stage: UpstreamStage, consumer: string, inputs: Ref[] = [],
    policy?: ProducerPolicy): Revision<DiscoveryDraft> {
    requireCondition(Object.hasOwn(REQUIREMENTS, stage), "stage_contract_missing", "No research contract for this stage");
    return this.create(projectId, stage, "R0", consumer, producerRequirements(stage, policy), inputs,
      producerContractEra(stage, policy));
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
    const questionWrites = specs.map((spec, i) => ({ id: questions[i]!, kind: "question", expected: 0,
      value: { projectId, draftId: id, stage, level, consumer, spec, beforeHash: hashJson(null), status: "open", answer: null } satisfies Question }));
    const closure: DiscoveryPrefixClosure = { contract: DISCOVERY_PREFIX_CLOSURE_CONTRACT, projectId,
      draftId: id, draft: { id, revision: 1, hash: hashJson(draft) }, inputs: draft.inputs, derivations: [],
      questions: questionWrites.map(write => ({ question: { id: write.id, revision: 1, hash: hashJson(write.value) }, answer: null })),
      external: [] };
    const writes = [{ id, kind: "discovery-draft", expected: 0, value: draft }, ...questionWrites,
      { id: discoveryPrefixClosureId(id, 1), kind: DISCOVERY_PREFIX_CLOSURE_KIND, expected: 0, value: closure }];
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
    if (draft.value.contractVersion === NEXT_CONTRACT_ERA)
      checkV7FieldAnswer(draft.value, q.spec, value, (field, ref) => {
        const target = draft.value.questions.map(questionId => this.store.get<Question>(questionId))
          .find(item => item !== null && item.value.spec.field === field);
        if (target === undefined || target === null) return null;
        try {
          const proven = proveIssuedAnswer(this.store, draft,
            { question: target, foreign: false, answered: true, answerRef: ref,
              field: target.value.spec.field }, undefined, { verifyIssuedQuestion: true });
          return proven.ok && provenAcceptance(proven.proof.provenance)
            && savedAcceptanceAct(this.store, draft, target, field, ref, proven.proof.value)
            ? proven.proof : null;
        } catch (error) {
          if (error instanceof EngineError && error.code === "invalid_json") return null;
          throw error;
        }
      });
    // D8.4.2 (№2230-1): a managed acceptance writes its answer at the address of its own paid
    // turn — consumers without a saved turn learn the provenance from the record itself; every
    // other acceptance keeps the random UUID address of its era.
    const id = managed ? managedAnswerId(q.projectId, managed.turn.id) : `${kind}:${q.projectId}:${randomUUID()}`;
    const answerRef: Ref = { id, revision: 1, hash: hashJson(answer) };
    const draftAfter = { ...draft.value, fields: { ...draft.value.fields, [q.spec.field]: value } };
    const questionAfter = { ...q, status: "answered" as const, answer: answerRef };
    const writes: Write[] = [
      { id: draft.id, kind: draft.kind, expected: draft.revision, value: draftAfter },
      { id, kind, expected: 0, value: answer },
      { id: question.id, kind: question.kind, expected: question.revision, value: questionAfter },
    ];
    // The records of this batch as the committed store will hold them — a managed closure proof
    // re-runs over this exact post-write state to capture the read set it pins.
    const pending: Revision<any>[] = [
      { id: draft.id, kind: draft.kind, revision: draft.revision + 1, hash: hashJson(draftAfter), value: draftAfter },
      { id, kind, revision: 1, hash: answerRef.hash, value: answer },
      { id: question.id, kind: question.kind, revision: question.revision + 1, hash: hashJson(questionAfter), value: questionAfter },
    ];
    const bindingGuards: TransactionGuard[] = [];
    let bindingRef: Ref | null = null;
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
      const bId = acceptanceBindingId(q.projectId, managed.turn.id);
      bindingRef = { id: bId, revision: 1, hash: hashJson(binding) };
      writes.push({ id: bId, kind: "research-acceptance-binding",
        expected: 0, value: binding });
      pending.push({ id: bId, kind: "research-acceptance-binding", revision: 1, hash: bindingRef.hash, value: binding });
      // O@1 and I are proven immutable revisions (their heads lawfully move
      // on); the current-state guards are P, B and R plus the CAS of the
      // three records and the absence of K.
      bindingGuards.push(managed.pending, managed.assessmentProof, reference(managed.assessment));
    }
    let actRef: Ref | null = null;
    if (draft.value.contractVersion === NEXT_CONTRACT_ERA) {
      const actId = discoveryAcceptanceActId(q.projectId, draft.id, q.spec.field, answerRef);
      const assessmentRef = kind === "research-answer" && isRef((answer as ResearchAnswer).assessment)
        ? (answer as ResearchAnswer).assessment
        : null;
      const actValue: DiscoveryAcceptanceAct = {
        contract: DISCOVERY_ACCEPTANCE_ACT_CONTRACT,
        projectId: q.projectId,
        draftId: draft.id,
        field: q.spec.field,
        draftBefore: reference(draft),
        draftAfter: { id: draft.id, revision: draft.revision + 1, hash: hashJson(draftAfter) },
        questionBefore: reference(question),
        questionAfter: { id: question.id, revision: question.revision + 1, hash: hashJson(questionAfter) },
        answer: answerRef,
        assessment: assessmentRef,
        binding: bindingRef,
      };
      writes.push({ id: actId, kind: DISCOVERY_ACCEPTANCE_ACT_KIND, expected: 0, value: actValue });
      actRef = { id: actId, revision: 1, hash: hashJson(actValue) };
      pending.push({ id: actId, kind: DISCOVERY_ACCEPTANCE_ACT_KIND, revision: 1, hash: actRef.hash, value: actValue });
    }
    // G4a (пул K ред.2, №6215 п.2; managed — №6284): the new revision carries the closure of its
    // accepted prefix in the same batch — built once by the same checks gate() applies to the whole
    // prefix, so a draft answered under an earlier era (no closure on the previous revision) gains
    // its closure here. A managed answer is closed on the captured read set of its own K proof
    // (heads as guards, exact revisions pinned); a rebound's source chain is unbounded and stays
    // on the full pass by design (the K itself is still written exactly as before).
    let closable = true;
    let closureAssessment: Ref | null = null; let closureSources: Ref[] = []; let closureRuntime: Ref[] = [];
    let managedReads: ManagedPrefixProof | null = null;
    if (kind === "research-answer") {
      closureAssessment = (answer as ResearchAnswer).assessment;
      const record = managed?.assessment
        ?? this.store.get<ResearchAssessment>(closureAssessment.id, closureAssessment.revision);
      requireCondition(record !== null && record.kind === "research-assessment" && record.hash === closureAssessment.hash,
        "research_acceptance_binding_invalid", `[${closureAssessment.id}] The accepted assessment is unavailable for the prefix closure`);
      closureSources = record.value.observations.map(item => item.source);
      closureRuntime = runtimeEvidenceDependencies(record.value.runtimeProofs ?? []);
      if (record.value.reusedFrom !== undefined) closable = false;
      if (managed) {
        const proven = this.#managedProofReads(q.projectId, answerRef, pending);
        if (proven === null || proven.accepted.binding === null
          || canonical(reference(proven.accepted.binding)) !== canonical(bindingRef)
          || proven.accepted.assessment === null
          || canonical(reference(proven.accepted.assessment)) !== canonical(closureAssessment)) closable = false;
        else managedReads = proven.reads;
      }
    } else if (kind === "fact") closureSources = [(answer as Fact).observation.source];
    const draftAfterRef: Revision<DiscoveryDraft> = pending[0] as Revision<DiscoveryDraft>;
    // №6348 G4a-02: the closure of the revision this write replaces lets the new one inherit its
    // verified prefix instead of re-reading every accepted answer.
    const previous = closable
      ? this.store.get<DiscoveryPrefixClosure>(discoveryPrefixClosureId(draft.id, draft.revision)) : null;
    const closure = closable ? this.#prefixClosure(q.projectId, draftAfterRef, { questionId: question.id,
      entry: { question: { id: question.id, revision: question.revision + 1, hash: hashJson(questionAfter) },
        answer: { answer: answerRef, assessment: closureAssessment, binding: bindingRef, act: actRef,
          sources: closureSources, runtimeDependencies: closureRuntime,
          field: q.spec.field, kind, value,
          observations: kind === "fact" ? 1 : closureSources.length,
          ...(managedReads ? { managed: managedReads } : {}) } } }, pending, previous) : null;
    if (closure !== null)
      writes.push({ id: discoveryPrefixClosureId(draft.id, draftAfterRef.revision),
        kind: DISCOVERY_PREFIX_CLOSURE_KIND, expected: 0, value: closure });
    return this.store.writeMany<DiscoveryDraft>(writes,
      uniqueTransactionGuards([...guards, ...draft.value.inputs, reference(question), reference(draft), ...bindingGuards]))[0]!;
  }
  decision(id: string, expected: number, actor: string, value: Json): Revision<DiscoveryDraft> {
    const question = this.#question(id, expected);
    requireCondition(question.value.spec.kind === "decision" || question.value.spec.kind === "design", "fact_requires_evidence", "An owner's choice cannot confirm a factual question");
    if (question.value.spec.proof === "assessment") {
      const draft = this.store.get<DiscoveryDraft>(question.value.draftId);
      requireCondition(draft?.value.contractVersion !== NEXT_CONTRACT_ERA, "research_assessment_required",
        "This v7 question needs research and an assessment, not an owner's choice");
    }
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
    // ASM1.1 (№4791): a direct assessment judged on an accepted prefix is accepted on that same prefix only. Its exact
    // neighbors and grounds come from its own saved material through the common reader, must still stand, and guard the
    // acceptance write itself — a reopen between this check and the write refuses the whole transaction.
    const prefix = managedPending === undefined ? directAssessmentBasis(this.store, assessment) ?? [] : [];
    for (const ref of prefix) {
      const head = this.store.get(ref.id);
      if (!head || canonical(reference(head)) !== canonical(ref))
        throw new EngineError('research_assessment_basis_stale', `[${ref.id}] The accepted prefix this assessment was judged on changed; assess the answer again on the current prefix`,
          { unit: 'research-acceptance', target: question.id, field: 'origin', ref });
    }
    const answer: ResearchAnswer = { projectId: question.value.projectId, question: id, assessment: assessmentRef, value: assessment.value.value };
    const guards: TransactionGuard[] = [assessmentRef, assessment.value.environment,
      ...assessment.value.observations.map(item => item.source), ...runtimeGuards, ...prefix];
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
      const accepted = readAcceptedResearchAnswer(this.store, question.value.projectId, question.value.answer);
      const assessment = accepted.assessment;
      requireCondition(assessment?.value.verdict === "supported", "research_not_supported", "Research evidence has no supported assessment");
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
  /** G4a (пул K ред.2, №6215 п.2): the closure of a revision's accepted prefix. When the replaced
   * revision already carries a well-formed closure of the same questions, an ordinary acceptance
   * verifies only the NEW entry and inherits the saved prefix verbatim — old heads/refs are never
   * refreshed, their own saved guards catch staleness at read (№6348 G4a-02). A revision with no
   * earlier closure is the one place the whole prefix is built once by the same checks gate()
   * applies: every earlier question is then read and verified by #closedEntry. A question this
   * build cannot cover — a stale head, refused provenance, an unsupported assessment, a missing
   * act — leaves the whole revision unclosed: a saved closure never certifies an unchecked prefix. */
  #prefixClosure(projectId: string, draftAfter: Revision<DiscoveryDraft>,
    fresh: { questionId: string; entry: PrefixClosureQuestion },
    pending: Revision<any>[] = [],
    previous: Revision<DiscoveryPrefixClosure> | null = null): DiscoveryPrefixClosure | null {
    // A draft carrying `derivations` AND questions never matches the gate's derivation check —
    // an empty list is a derivation_stale, a nonempty one a derivation_conflict — the closure
    // cannot represent either, so such a draft stays unclosed.
    if (draftAfter.value.derivations !== undefined && draftAfter.value.questions.length) return null;
    const ids = draftAfter.value.questions;
    const inherited = previous !== null && previous.kind === DISCOVERY_PREFIX_CLOSURE_KIND
      && previous.revision === 1 && shapeClosure(previous.value, projectId, draftAfter.id, ids)
      && (previous.value.draft as Ref).revision === draftAfter.revision - 1 ? previous.value : null;
    let questions: PrefixClosureQuestion[];
    if (inherited !== null)
      questions = ids.map((id, index) => id === fresh.questionId ? fresh.entry : inherited.questions[index]!);
    else {
      questions = [];
      for (const questionId of ids) {
        if (questionId === fresh.questionId) { questions.push(fresh.entry); continue; }
        const head = this.store.get<Question>(questionId);
        if (!head || head.kind !== "question" || head.value.projectId !== projectId
          || head.value.draftId !== draftAfter.id) return null;
        const entry = this.#closedEntry(projectId, draftAfter, head, pending);
        if (entry === null) return null;
        questions.push(entry);
      }
    }
    // File sources are external: their bytes live outside the store, so a matching head is not
    // enough — each one is declared as a `source` check re-executed on every closed read. An
    // inherited prefix keeps only the checks whose exact Ref the resulting entries still use —
    // a replaced answer's source is dropped with it, a source shared by another accepted answer
    // stays (№6403 G4a-03); the fresh entry's sources (or, on a full build, every entry's) are
    // looked up here.
    const usedSources = new Set(questions
      .flatMap(entry => entry.answer?.sources ?? []).map(ref => canonical(ref)));
    const external = new Map<string, StageExternalCheck>();
    for (const check of inherited?.external ?? [])
      if (check.kind === "source" && usedSources.has(canonical(check.ref))) external.set(check.ref.id, check);
    const sourceRefs = uniqueRefs((inherited === null ? questions : [fresh.entry])
      .flatMap(entry => entry.answer?.sources ?? []));
    for (const ref of sourceRefs) {
      const source = this.store.get<Source>(ref.id);
      if (!source || source.kind !== "source") return null;
      if (source.value.origin.kind === 'file') external.set(ref.id, { kind: "source", ref });
    }
    return { contract: DISCOVERY_PREFIX_CLOSURE_CONTRACT, projectId, draftId: draftAfter.id,
      draft: reference(draftAfter), inputs: draftAfter.value.inputs,
      derivations: (draftAfter.value.derivations ?? []).map(entry => entry.source),
      questions, external: [...external.values()] };
  }
  /** G4a (№6284): the reads the common accepted-answer reader performs for one research answer,
   * captured through a recording view so a managed prefix can pin them all — head reads as head
   * requirements (K@1 among them), head-absences, exact reads pinned by presence and hash (the
   * pending/intent/turn chains, B, M, session, the replayed assessment-read proof), exact misses
   * by their absence. `pending` serves the records of the not-yet-committed batch (K, the answer,
   * the new draft/question revisions), so the proof runs over the exact post-write state. Returns
   * null when the proof refuses or reads anything a closure cannot pin (a non-get read has no
   * exact form): such an answer keeps the full pass. */
  #managedProofReads(projectId: string, answerRef: Ref, pending: Revision<any>[]): {
    accepted: ReturnType<typeof readAcceptedResearchAnswer>; reads: ManagedPrefixProof } | null {
    const heads: Ref[] = [], absentHeads: string[] = [];
    const pinned: Ref[] = [], absentPinned: { id: string; revision: number }[] = [];
    const rows = new Map(pending.map(row => [`${row.id}:${row.revision}`, row]));
    const pendingHeads = new Map(pending.map(row => [row.id, row]));
    let unclosable = false;
    const store = this.store;
    const view = new Proxy(store, {
      get(target, key) {
        if (key === "get") return (id: string, revision?: number) => {
          const row = revision === undefined ? pendingHeads.get(id) : rows.get(`${id}:${revision}`);
          const record = row !== undefined ? row : store.get(id, revision);
          if (revision === undefined) { if (record) heads.push(reference(record)); else absentHeads.push(id); }
          else if (record !== null) pinned.push({ id, revision, hash: record.hash });
          else absentPinned.push({ id, revision });
          return record;
        };
        const value = Reflect.get(target, key, target);
        if (typeof value === "function")
          return (...args: unknown[]) => { unclosable = true; return (value as (...a: unknown[]) => unknown).apply(target, args); };
        return value;
      }
    });
    let accepted: ReturnType<typeof readAcceptedResearchAnswer>;
    try { accepted = readAcceptedResearchAnswer(view, projectId, answerRef); }
    catch (error) {
      if (error instanceof EngineError && error.code.startsWith("research_")) return null;
      throw error;
    }
    // A revision the proof found missing can be created lawfully later — snapshot each such
    // entity's write-time head (or its absence) as an ordinary head requirement: any later
    // creation moves that head and the closed read falls back (№6348 G4a-01).
    const headCovered = new Set([...heads.map(ref => ref.id), ...absentHeads]);
    for (const { id } of absentPinned) if (!headCovered.has(id)) view.get(id);
    if (unclosable) return null;
    return { accepted, reads: {
      heads: uniqueRefs(heads), absentHeads: [...new Set(absentHeads)], pinned: uniqueRefs(pinned),
      absentPinned: [...new Map(absentPinned.map(row => [`${row.id}:${row.revision}`, row])).values()] } };
  }
  /** G4a: the gate's own checks for one already-answered question, run once when its draft revision
   * is closed — and the exact heads/refs the closed read compares instead. Returns null when the
   * check the gate would make today does not pass: the prefix then writes no closure at all. */
  #closedEntry(projectId: string, after: Revision<DiscoveryDraft>, question: Revision<Question>,
    pending: Revision<any>[] = []): PrefixClosureQuestion | null {
    const entry: PrefixClosureQuestion = { question: reference(question), answer: null };
    const q = question.value;
    if (q.status !== "answered" || !q.answer) return entry;
    const ref = q.answer;
    const answer = this.store.get<Decision | Fact | ResearchAnswer>(ref.id);
    if (!answer || answer.hash !== ref.hash || answer.revision !== ref.revision
      || answer.value.projectId !== projectId || answer.value.question !== question.id
      || (answer.kind !== q.spec.kind && answer.kind !== "research-answer")) return null;
    let act: Ref | null = null;
    if (after.value.contractVersion === NEXT_CONTRACT_ERA) {
      const record = this.store.get<DiscoveryAcceptanceAct>(
        discoveryAcceptanceActId(projectId, after.id, q.spec.field, ref));
      if (record?.kind !== DISCOVERY_ACCEPTANCE_ACT_KIND || record.revision !== 1
        || hashJson(record.value) !== record.hash) return null;
      act = reference(record);
    }
    const onTarget = (value: Json): boolean => canonical(value) === canonical(after.value.fields[q.spec.field]);
    if (answer.kind === "research-answer") {
      const research = answer.value as ResearchAnswer;
      const proven = this.#managedProofReads(projectId, ref, pending);
      if (proven === null) return null;
      const { accepted, reads } = proven;
      const assessment = accepted.assessment;
      // A rebound's source chain is unbounded — it stays on the full pass by design.
      if (assessment?.value.reusedFrom !== undefined) return null;
      const issued = assessment ? this.store.get<Question>(assessment.value.question.id, assessment.value.question.revision) : null;
      if (assessment?.kind !== "research-assessment" || assessment.hash !== research.assessment.hash
        || assessment.revision !== research.assessment.revision || assessment.value.verdict !== "supported"
        || issued?.hash !== assessment.value.question.hash || issued.id !== question.id
        || canonical(issued.value.spec) !== canonical(q.spec) || assessment.value.researcher === assessment.value.assessor
        || assessment.value.observations.length === 0
        || !assessment.value.observations.every(item => this.evidence.verify(item))
        || canonical(assessment.value.value) !== canonical(research.value)
        || !onTarget(research.value)) return null;
      entry.answer = { answer: ref, assessment: reference(assessment), binding: accepted.binding ? reference(accepted.binding) : null, act,
        sources: assessment.value.observations.map(item => item.source),
        runtimeDependencies: runtimeEvidenceDependencies(assessment.value.runtimeProofs ?? []),
        field: q.spec.field, kind: answer.kind, value: research.value,
        observations: assessment.value.observations.length,
        ...(accepted.binding ? { managed: reads } : {}) };
      return entry;
    }
    if (answer.kind === "fact") {
      const observation = (answer.value as Fact).observation;
      if (!this.evidence.verify(observation) || !onTarget(observation.value)) return null;
      entry.answer = { answer: ref, assessment: null, binding: null, act,
        sources: [observation.source], runtimeDependencies: [],
        field: q.spec.field, kind: answer.kind, value: observation.value, observations: 1 };
      return entry;
    }
    const decision = answer.value as Decision;
    if (!decision.actor?.trim() || !onTarget(decision.value)) return null;
    entry.answer = { answer: ref, assessment: null, binding: null, act, sources: [], runtimeDependencies: [],
      field: q.spec.field, kind: answer.kind, value: decision.value, observations: 0 };
    return entry;
  }
  /** G4a: the committed prefix answers the gate — one closure record read at the deterministic
   * address, every saved head compared in the shared snapshot (or by observable gets on opaque views
   * and inside an active capture), then each declared external check re-executed. Returns null on a
   * missing closure or any miss — the caller then takes the previous full pass for the exact finding;
   * a malformed record is an addressed refusal, never a silent pass. An empty or partial prefix keeps
   * `question_unresolved` on its unanswered questions (№6215 п.1). The saved body's hash and the
   * managed proofs' pinned immutable revisions are not re-verified row by row (№6348 G4a-01):
   * committed bytes are the offline checker's domain, exactly as for the records the full pass
   * reads without re-hashing them either. */
  #closedPrefix(projectId: string, draft: Revision<DiscoveryDraft>): GateResult | null {
    const record = this.store.get<DiscoveryPrefixClosure>(discoveryPrefixClosureId(draft.id, draft.revision));
    if (record === null) return null;
    const invalid = (message: string): GateResult => ({ guards: [],
      findings: [{ code: "discovery_prefix_closure_invalid", target: record.id, message }] });
    const value = record.value;
    // The record is trusted by its structural form at the deterministic address — the saved body's
    // hash is not recomputed here (№6348 G4a-01): byte integrity of committed records is the
    // offline checker's (om-fsck) domain, exactly as for every record the full pass reads.
    if (record.kind !== DISCOVERY_PREFIX_CLOSURE_KIND || record.revision !== 1
      || !shapeClosure(value, projectId, draft.id, draft.value.questions)
      || canonical(value.draft) !== canonical(reference(draft)))
      return invalid("The recorded prefix closure is missing, foreign or malformed");
    const guards: TransactionGuard[] = [...value.inputs, ...value.derivations];
    for (const entry of value.questions) {
      guards.push(entry.question);
      if (entry.answer !== null) {
        guards.push(entry.answer.answer, ...entry.answer.runtimeDependencies, ...entry.answer.sources);
        if (entry.answer.assessment) guards.push(entry.answer.assessment);
        if (entry.answer.binding) guards.push(entry.answer.binding);
        if (entry.answer.act) guards.push(entry.answer.act);
        if (entry.answer.managed) {
          guards.push(...entry.answer.managed.heads);
          for (const id of entry.answer.managed.absentHeads) guards.push({ id, absent: true });
        }
      }
    }
    if (!transactionGuardsCurrent(this.store, uniqueTransactionGuards(guards))) return null;
    // The managed proofs' pinned exact revisions are immutable rows — verified once when the
    // closure was written and audited by om-fsck, not re-verified row by row here (№6348 G4a-01):
    // the batch cost stays C+ceil(D/chunk) whatever the accepted prefix's size.
    const physical = provenStore(this.store);
    const memoRef = physical !== null && !storeObserved(physical);
    for (const check of value.external) {
      if (check.kind !== "source") return invalid("The recorded prefix closure declares an unsupported check");
      const source = this.store.get<Source>(check.ref.id);
      if (source?.kind !== "source" || source.revision !== check.ref.revision || source.hash !== check.ref.hash
        || !sourceIsCurrent(source.value, memoRef ? check.ref : undefined)) return null;
    }
    const findings: Finding[] = [];
    const output: Ref[] = [reference(draft), ...value.derivations, ...value.inputs];
    const entries: AcceptedPrefixEntry[] = [];
    for (const entry of value.questions) {
      const answer = entry.answer;
      if (answer === null) {
        findings.push({ code: "question_unresolved", target: entry.question.id, message: "Question has no accepted answer" });
        continue;
      }
      output.push(entry.question, answer.answer, ...answer.runtimeDependencies,
        ...(answer.assessment ? [answer.assessment] : []), ...answer.sources,
        ...(answer.binding ? [answer.binding] : []));
      entries.push({ question: entry.question, field: answer.field, status: "answered",
        kind: answer.kind, answer: answer.answer, value: answer.value,
        assessment: answer.assessment, observations: answer.observations });
    }
    // Решение №6253/6254: the snapshot exists only on this checked path — every guard and pinned
    // revision compared above — never on a fallback or the full pass.
    return { findings, guards: uniqueRefs(output),
      prefix: { contract: "discovery-prefix/v1", draft: reference(draft), closure: reference(record), entries } };
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
    // G4a: a recorded prefix closure answers the whole accepted prefix by saved heads plus the
    // declared external checks — a missing record or any miss falls through to the full pass below.
    const closed = this.#closedPrefix(projectId, draft);
    if (closed !== null) return closed;
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
        // D8.4.2 (№2230): provenance first — the common reader (a managed address must name its
        // own turn's K, damaged/missing K is a finding, not a silent pass); the checks after it
        // are today's admission for new work, unchanged by the historical proof.
        let accepted: ReturnType<typeof readAcceptedResearchAnswer>;
        try { accepted = readAcceptedResearchAnswer(this.store, projectId, ref); }
        catch (error) {
          if (error instanceof EngineError && error.code.startsWith('research_')) {
            fail(error.code, id, error.message); continue;
          }
          throw error;
        }
        const assessment = accepted.assessment;
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
        guards.push(reference(assessment), ...assessment.value.observations.map(item => item.source));
        // The exact K of a managed answer is an immutable base of the gate's result: it lands in
        // stage.proofs / layerProof.inputs through the guards of this gate (№2230-3).
        if (accepted.binding) guards.push(reference(accepted.binding));
        value = research.value;
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

/** D8.4.2 (№2230-2, №2276): the common reader of an accepted research answer for every consumer.
 * The exact answer record is read at its Ref; its address (the producer's saved form) decides the
 * era. A legacy address of this project keeps its producer's contract: the assessment is returned
 * as read by the exact Ref (its absence or change is the caller's legacy finding, not a refusal
 * here) — and when that assessment is a rebound (reusedFrom), its source chain is proven to the
 * end: every source is the assessment of an exact historical acceptance of its own question
 * revision (a managed source through its own K), and each rebound differs from its source only in
 * question and reusedFrom. A managed address names the exact paid turn: K is read by the shared
 * D8.4e reader — which proves O/P/I, the pair and R/B/M/S/A — and must name this very answer and
 * its assessment. A foreign, malformed, missing or damaged address or record is an addressed
 * refusal — never a scan, never a legacy branch. The read ends at P: a written K without a
 * completed turn is lawful. */
export function readAcceptedResearchAnswer(store: Store, projectId: string, answerRef: Ref): {
  answer: Revision<ResearchAnswer>; assessment: Revision<ResearchAssessment> | null;
  binding: Revision<ResearchAcceptanceBinding> | null } {
  return readAcceptedAnswerChain(store, projectId, answerRef, new Set<string>());
}
function readAcceptedAnswerChain(store: Store, projectId: string, answerRef: Ref, seen: Set<string>): {
  answer: Revision<ResearchAnswer>; assessment: Revision<ResearchAssessment> | null;
  binding: Revision<ResearchAcceptanceBinding> | null } {
  requireCondition(isRef(answerRef), 'research_acceptance_binding_invalid',
    'An accepted research answer needs its exact reference');
  const answer = store.get<ResearchAnswer>(answerRef.id, answerRef.revision);
  requireCondition(answer?.kind === 'research-answer' && answer.hash === answerRef.hash
    && answer.value.projectId === projectId && isRef(answer.value.assessment),
    'research_acceptance_binding_invalid', `[${answerRef.id}] The accepted research answer is missing, foreign or changed`);
  const turnId = managedAnswerTurn(answer.id, projectId);
  if (turnId === null) {
    const ref = answer.value.assessment;
    const assessment = store.get<ResearchAssessment>(ref.id, ref.revision);
    if (assessment?.kind !== 'research-assessment' || assessment.hash !== ref.hash) return { answer, assessment: null, binding: null };
    if (assessment.value.reusedFrom !== undefined) proveReboundSource(store, projectId, assessment, seen);
    return { answer, assessment, binding: null };
  }
  const proven = readResearchAcceptanceBinding(store, projectId, turnId);
  requireCondition(proven !== null, 'research_acceptance_binding_invalid',
    `[${answerRef.id}] The managed research answer has no acceptance record of its turn`);
  requireCondition(canonical(proven.binding.value.answer) === canonical(answerRef)
    && canonical(proven.binding.value.assessment) === canonical(answer.value.assessment),
    'research_acceptance_binding_invalid',
    `[${answerRef.id}] The acceptance record of this turn names another answer or assessment`);
  return { answer, assessment: proven.assessment, binding: proven.binding };
}
/** D8.4.2 (№2276-3): the finite common derivation of a rebound's source. The source named by
 * reusedFrom is read exactly; its own question revision must have been accepted historically —
 * the next revision of that exact question is answered, and that answer (read through the common
 * reader: a managed source proves its own K, a legacy source its own assessment and chain) carries
 * exactly this source as its assessment; the rebound equals the source with only question and
 * reusedFrom changed. A cyclic, lost, foreign or non-derivable source is an addressed refusal —
 * at reading (observations, gate) as before a new reuse write. */
function proveReboundSource(store: Store, projectId: string, rebound: Revision<ResearchAssessment>, seen: Set<string>): void {
  const refuse = (reason: string): never => {
    throw new EngineError('research_reuse_source_invalid',
      `[${rebound.id}] The rebound assessment does not derive from an exact accepted source: ${reason}`,
      { ref: reference(rebound), reason });
  };
  const link = rebound.value.reusedFrom;
  if (!isRef(link)) return refuse('source-link');
  if (seen.has(rebound.id) || seen.has(link.id)) return refuse('source-cycle');
  seen.add(rebound.id);
  const source = store.get<ResearchAssessment>(link.id, link.revision);
  if (!source || source.kind !== 'research-assessment' || source.hash !== link.hash || hashJson(source.value) !== source.hash
    || source.value.projectId !== projectId) return refuse('source-lost');
  if (canonical({ ...source.value, question: rebound.value.question, reusedFrom: link }) !== canonical(rebound.value)) return refuse('rebound-formula');
  const issuedRef = source.value.question;
  const issued = isRef(issuedRef) ? store.get<Question>(issuedRef.id, issuedRef.revision) : null;
  const accepted = issued ? store.get<Question>(issuedRef.id, issuedRef.revision + 1) : null;
  const acceptedAnswer = accepted?.value.answer;
  if (!issued || issued.kind !== 'question' || issued.hash !== issuedRef.hash || issued.value.projectId !== projectId
    || !accepted || accepted.kind !== 'question' || accepted.value.status !== 'answered' || !isRef(acceptedAnswer)
    || canonical({ ...issued.value, status: 'answered', answer: acceptedAnswer }) !== canonical(accepted.value)) return refuse('source-acceptance');
  const sourceAnswer = readAcceptedAnswerChain(store, projectId, acceptedAnswer, seen);
  if (!sourceAnswer.assessment || canonical(reference(sourceAnswer.assessment)) !== canonical(link)) refuse('source-assessment');
}

import { proveAppliedAttemptClaim } from './v7-progress.js';
import { EngineError } from "../errors.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import type { Json } from "../canonical.js";
import type { Store, Revision } from "../storage/store.js";
import { proveIssuedAnswer, savedAcceptanceAct, issuedAnswerSchemaHolds } from "./projection-reader.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { PaidDiscoveryAttemptsAssessment, V7ProgressApplication, ResearchAnswer, ResearchAssessment } from "./research-model.js";
import type { ResearchAcceptanceBinding } from "./research-consumer-transition.js";
import { DISCOVERY_CLAIMS_CONTRACT, V7_ATTEMPT_KIND, provenAcceptance } from "./v7-contracts.js";
import { proveAttempt, type V7Attempt } from "./v7-plan-questions.js";

/** The record contract marking a typed claims collection: at the body root
 * of a claims-carrying research answer (DR2), and at the submitted end of a
 * research attempt (DR3a1) — a marker inside an arbitrary payload never
 * makes a record this contract. */
export { DISCOVERY_CLAIMS_CONTRACT };

/** Typed address of a claim inside an immutable accepted container
 * (strategy A): the exact Ref of the container record, the kind it must
 * carry, the JSON Pointer /claims/<i> into ResearchAnswer.value and the claim
 * id asserted at that element, unique inside the container. */
export interface ClaimAddress {
  project: string;
  container: Ref;
  containerKind: string;
  pointer: string;
  claimId: string;
}

interface ClaimsAnswer extends ResearchAnswer { contract: string }

export interface ResolvedClaim { container: Revision<ClaimsAnswer> | Revision<V7Attempt>; claim: Json }
/** A resolved claim with the separate proof that its container is accepted —
 * resolution alone never stands for acceptance. */
export interface ProvenAnswerClaim extends ResolvedClaim {
  kind: 'answer';
  container: Revision<ClaimsAnswer>;
  answer: Revision<ResearchAnswer>;
  assessment: Revision<ResearchAssessment> | null;
  binding: Revision<ResearchAcceptanceBinding> | null;
}

export interface ProvenAttemptClaim extends ResolvedClaim {
  kind: 'attempt'; container: Revision<V7Attempt>; answer: null; binding: null;
  assessment: Revision<PaidDiscoveryAttemptsAssessment>; application: Revision<V7ProgressApplication>;
}
export type ProvenClaim = ProvenAnswerClaim | ProvenAttemptClaim;

const CLAIM_POINTER = /^\/claims\/(0|[1-9][0-9]*)$/;
const object = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A function declaration — const arrow `never` loses narrowing under this compiler.
function refuse(address: unknown, field: string, reason: string): never {
  throw new EngineError("claim_address_invalid",
    `[${field}] The claim address is not provable: ${reason}`, { field, address });
}

/** Structural resolve of a claim address: the container record exists at the
 * exact saved revision and hash, carries the named kind, project and the
 * claims contract at its body root, and the pointer names the element whose
 * id is the addressed claim id, unique inside the container. Reading stays at
 * the saved Ref — the current head of the container is not required. */
export function resolveClaimAddress(store: Store, address: ClaimAddress): ResolvedClaim {
  const a = address as unknown as Record<string, unknown>;
  if (!object(a) || typeof a["project"] !== "string" || a["project"].length === 0
    || !isRef(a["container"]) || typeof a["containerKind"] !== "string" || a["containerKind"].length === 0
    || typeof a["pointer"] !== "string" || typeof a["claimId"] !== "string" || a["claimId"].length === 0)
    refuse(address, "address", "an address needs project, an exact container Ref, containerKind, pointer and claimId");
  const pointer = CLAIM_POINTER.exec(a["pointer"] as string);
  if (pointer === null || !Number.isSafeInteger(Number(pointer[1])))
    refuse(address, "pointer", "the pointer must be /claims/<index>");
  const index = Number(pointer[1]);
  if (a["containerKind"] === "research-answer") return resolveAnswerClaim(store, address, index);
  if (a["containerKind"] === V7_ATTEMPT_KIND) return resolveAttemptClaim(store, address, index);
  refuse(address, "containerKind", "the claims contract lives on a research-answer or a research-attempt record");
}

function resolveAnswerClaim(store: Store, address: ClaimAddress, index: number): ResolvedClaim {
  const a = address as unknown as Record<string, unknown>;
  const containerRef = a["container"] as Ref;
  const container = store.get<ClaimsAnswer>(containerRef.id, containerRef.revision);
  if (container === null || container.kind !== a["containerKind"] || container.hash !== containerRef.hash)
    refuse(address, "container", "the container record is missing, foreign or changed");
  if (container.value.projectId !== a["project"])
    refuse(address, "project", "the container belongs to another project");
  if (container.value.contract !== DISCOVERY_CLAIMS_CONTRACT)
    refuse(address, "container", "the container is not a v7 claims record");
  const payload = container.value.value;
  const claims = object(payload) && Array.isArray(payload["claims"]) ? payload["claims"] : null;
  const claim = claims === null ? null : claims[index];
  if (!object(claim)) refuse(address, "pointer", "the pointer does not name a claim element");
  if (claim["id"] !== a["claimId"])
    refuse(address, "claimId", "the element at the pointer carries another id");
  const copies = claims!.filter(item => object(item) && item["id"] === a["claimId"]).length;
  if (copies !== 1)
    refuse(address, "claimId", "the claim id is not unique inside its container");
  return { container, claim };
}

/** The attempt route of DR3a1: the saved containerKind routes the address
 * through the attempt reader — a consistent, project-owning submitted
 * attempt is the claims container of its claims. A damaged, foreign or
 * inconsistent attempt refuses the address; there is no fallback to the
 * field-answer path for an attempt container. */
function resolveAttemptClaim(store: Store, address: ClaimAddress, index: number): ResolvedClaim {
  const a = address as unknown as Record<string, unknown>;
  let proof: ReturnType<typeof proveAttempt>;
  try { proof = proveAttempt(store, a["container"] as Ref); }
  catch (error) {
    if (error instanceof EngineError)
      refuse(address, "container", `the addressed attempt is not a consistent claims container: ${error.message}`);
    throw error;
  }
  if (proof.attempt.value.project !== a["project"])
    refuse(address, "project", "the container belongs to another project");
  if (proof.claims === undefined)
    refuse(address, "container", "only a submitted attempt carries a claims collection");
  const claim = proof.claims[index];
  if (!object(claim)) refuse(address, "pointer", "the pointer does not name a claim element");
  if (claim["id"] !== a["claimId"])
    refuse(address, "claimId", "the element at the pointer carries another id");
  return { container: proof.attempt, claim };
}

/** The acceptance half of a claims container, interpreted by the common
 * answer-provenance reader: a managed acceptance is proven by its saved
 * binding K; every other research answer needs its own supported, well-formed
 * assessment of this exact value by an independent assessor, bound to the
 * named question, with its observations. The record's existence alone is
 * never an acceptance. The predicate itself lives in v7-contracts — the plan
 * reader proves the same provenance for its accepted plan answers. */
export { provenAcceptance };

/** The separate half: the addressed claim is usable only when its container
 * is proven an accepted answer of the question it names — question record,
 * draft and acceptance chain read through the same interpretation the
 * projection reader gives every consumer. A resolvable but unaccepted
 * container is an addressed refusal. An attempt requires its exact pointer in
 * the first atomic application; a paid assessment alone is insufficient. */
export function proveClaimAddress(store: Store, address: ClaimAddress): ProvenClaim {
  const resolved = resolveClaimAddress(store, address);
  if (resolved.container.kind === V7_ATTEMPT_KIND) {
    let proof: ReturnType<typeof proveAppliedAttemptClaim>;
    try { proof = proveAppliedAttemptClaim(store, address); }
    catch (error) {
      // Keep the public refusal contract of historical unapplied attempts.
      // P.3 retains its internal field diagnostic; this address remains the subject.
      if (error instanceof EngineError && error.code === 'claim_attempt_not_accepted')
        throw new EngineError(error.code, error.message, { address });
      throw error;
    }
    return { ...resolved, kind: 'attempt', container: resolved.container as Revision<V7Attempt>,
      answer: null, binding: null, ...proof };
  }
  const container = resolved.container as Revision<ClaimsAnswer>;
  const question = store.get<Question>(container.value.question);
  if (question === null || question.kind !== "question" || question.value.projectId !== address.project)
    refuse(address, "question", "the container does not answer a question of this project");
  const draft = store.get<DiscoveryDraft>(question.value.draftId);
  if (draft === null)
    refuse(address, "question", "the container's question has no saved draft");
  let proven: ReturnType<typeof proveIssuedAnswer>;
  try {
    proven = proveIssuedAnswer(store, draft,
      { question, foreign: false, answered: true, answerRef: address.container,
        field: question.value.spec.field },
      container as unknown as Revision<Record<string, unknown>>,
      { verifyIssuedQuestion: true });
  } catch (error) {
    // A record whose acceptance chain reads to nothing (e.g. a missing
    // assessment leaves an uninterpretable comparison) is unaccepted.
    if (error instanceof EngineError && error.code === "invalid_json")
      refuse(address, "container", "the addressed claim lives in an answer that was never accepted");
    throw error;
  }
  if (!proven.ok || !provenAcceptance(proven.proof.provenance)
    || draft.kind !== "discovery-draft" || draft.value.projectId !== address.project
    || !draft.value.questions.includes(question.id)
    || !issuedAnswerSchemaHolds(question, proven.proof.value)
    || !savedAcceptanceAct(store, draft, question, question.value.spec.field,
      address.container, proven.proof.value))
    refuse(address, "container", "the addressed claim lives in an answer that was never accepted");
  const provenance = proven.proof.provenance;
  return { ...resolved, kind: 'answer', container,
    answer: proven.proof.record as unknown as Revision<ResearchAnswer>,
    assessment: provenance.assessment, binding: provenance.binding };
}

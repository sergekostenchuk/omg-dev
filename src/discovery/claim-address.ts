import { EngineError } from "../errors.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import type { Json } from "../canonical.js";
import type { Store, Revision } from "../storage/store.js";
import { proveIssuedAnswer, savedAcceptanceAct, issuedAnswerSchemaHolds,
  type AnswerProvenance, type ResearchProvenance } from "./projection-reader.js";
import type { DiscoveryDraft, Question } from "./discovery.js";
import type { ResearchAnswer, ResearchAssessment } from "./research-model.js";
import type { ResearchAcceptanceBinding } from "./research-consumer-transition.js";

/** The record contract marking a research-answer that carries a typed claims
 * collection at value.claims. It sits at the root of the record body, next to
 * projectId/question/assessment; a marker inside the payload does not make a
 * record this contract. The v7 producer writes it (DR3a); DR2 declares the
 * address and the traversal contract on it. */
export const DISCOVERY_CLAIMS_CONTRACT = "discovery-claims/v7";

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

export interface ResolvedClaim { container: Revision<ClaimsAnswer>; claim: Json }
/** A resolved claim with the separate proof that its container is accepted —
 * resolution alone never stands for acceptance. */
export interface ProvenClaim extends ResolvedClaim {
  answer: Revision<ResearchAnswer>;
  assessment: Revision<ResearchAssessment> | null;
  binding: Revision<ResearchAcceptanceBinding> | null;
}

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
  if (a["containerKind"] !== "research-answer")
    refuse(address, "containerKind", "the claims contract lives only on research-answer records");
  const pointer = CLAIM_POINTER.exec(a["pointer"] as string);
  if (pointer === null || !Number.isSafeInteger(Number(pointer[1])))
    refuse(address, "pointer", "the pointer must be /claims/<index>");
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
  const claim = claims === null ? null : claims[Number(pointer[1])];
  if (!object(claim)) refuse(address, "pointer", "the pointer does not name a claim element");
  if (claim["id"] !== a["claimId"])
    refuse(address, "claimId", "the element at the pointer carries another id");
  const copies = claims!.filter(item => object(item) && item["id"] === a["claimId"]).length;
  if (copies !== 1)
    refuse(address, "claimId", "the claim id is not unique inside its container");
  return { container, claim };
}

/** The acceptance half of a claims container, interpreted by the common
 * answer-provenance reader: a managed acceptance is proven by its saved
 * binding K; every other research answer needs its own supported, well-formed
 * assessment of this exact value by an independent assessor, bound to the
 * named question, with its observations. The record's existence alone is
 * never an acceptance. */
export function provenAcceptance(provenance: AnswerProvenance): provenance is ResearchProvenance {
  if (provenance.kind !== "research-answer") return false;
  if (provenance.binding !== null) return true;
  return provenance.supported && provenance.wellFormed && provenance.independent
    && provenance.valueMatches && provenance.bindsQuestion === true && provenance.hasObservations
    && provenance.observations.every(item => object(item)
      && typeof item["projectId"] === "string" && isRef(item["source"])
      && object(item["selector"]) && item["value"] !== undefined);
}

/** The separate half: the addressed claim is usable only when its container
 * is proven an accepted answer of the question it names — question record,
 * draft and acceptance chain read through the same interpretation the
 * projection reader gives every consumer. A resolvable but unaccepted
 * container is an addressed refusal, not a claim. */
export function proveClaimAddress(store: Store, address: ClaimAddress): ProvenClaim {
  const resolved = resolveClaimAddress(store, address);
  const question = store.get<Question>(resolved.container.value.question);
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
      resolved.container as unknown as Revision<Record<string, unknown>>,
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
  return { ...resolved,
    answer: proven.proof.record as unknown as Revision<ResearchAnswer>,
    assessment: provenance.assessment, binding: provenance.binding };
}

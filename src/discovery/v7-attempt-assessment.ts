import { checkAssessmentMethodology, checkMethodologyRequirements, ASSESSMENT_METHODOLOGY_POLICY, ASSESSMENT_METHODOLOGY_POLICY_V2 } from "./assessment-methodology.js";
import { canonical, digest, hashJson, type Json } from "../canonical.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { EngineError } from "../errors.js";
import type { Store, Revision, TransactionGuard } from "../storage/store.js";
import { readExact } from "./projection-reader.js";
import { proveAttempt, type V7AttemptProof, type V7PlanQuestion } from "./v7-plan-questions.js";
import { V7_ATTEMPT_KIND } from "./v7-contracts.js";
import { ATTEMPT_BINDING_KIND, attemptBindingId, type ResearchAttemptBinding } from "./v7-managed-attempt.js";
import { readResearchAttemptBinding, readResearchConsumerTurn } from "./response-recovery.js";
import type { ManagedResearchTurn } from "./research-consumer-transition.js";
import { proveClaimAddress, resolveClaimAddress, type ClaimAddress, type ResolvedClaim } from "./claim-address.js";
import { readDiscoveryConditionDecision, type DiscoveryConditionDecision } from "./discovery-outcome.js";
import { variantOwnerActContent } from "./variant-scope.js";
import type { Source } from "../evidence/evidence.js";
import { DISCOVERY_ASSESSMENT_CONTRACT, V7_ATTEMPT_PACKET_CONTRACT, V7_PROGRESS_BASELINE_CONTRACT,
  type VersionedDiscoveryAttemptsAssessment, DISCOVERY_ASSESSMENT_CONTRACT_V2, DISCOVERY_ASSESSMENT_CONTRACT_V3, type V7AttemptPacket, type V7AttemptPacketEntry, type V7Novelty,
  type V7ProgressBaseline, type V7QuestionTransition } from "./research-model.js";

/* DR3b-M (codex-omg №7546 §1, the M slice): the subject, the forms and the keys of a v7 attempts assessment.
 *
 * One packet is one plan-question of one exact plan edition: the completed managed attempts proven through the DR3a2
 * door AND their attempt binding K (with the managed turn completed through it), in the proven order — the ascending
 * number of the K original turn in the one research run of the draft. The baseline fixes the exact previous progress
 * state of the question (or its explicit absence) and the exact accepted materials the novelty is judged against.
 * The assessment is a separate discriminated record form with a mandatory, complete novelty classification.
 *
 * Everything here is STRUCTURAL: these readers and projectors never stand for a paid assessment (DR3b-A proves the
 * paid session/application) nor for its application, the claim acceptance or N (DR3b-P). The content key is a
 * versioned code contract — the model never assigns keys, ordinals or N. */

export const DISCOVERY_ASSESSMENT_KIND = "discovery-assessment" as const;
/** The record kind of the per-question progress state (written by DR3b-P); its address is fixed here because the
 * baseline names it — present or explicitly absent — before the packet is paid. */
export const V7_PROGRESS_STATE_KIND = "v7-progress-state" as const;
export const DISCOVERY_CONTENT_KEY_CONTRACT = "discovery-content-key/v1" as const;

/** The subject address shared by the packet, the baseline and both keys. */
export interface V7AssessmentSubject { project: string; planAnswer: Ref; planQuestionId: string }

const obj = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) =>
  Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
  && keys.every(key => Object.hasOwn(value, key));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const exactRef = (record: Revision<unknown>): Ref => ({ id: record.id, revision: record.revision, hash: record.hash });

// Function declarations — const arrow `never` loses narrowing under this compiler.
function subjectInvalid(field: string, reason: string, details: Record<string, unknown> = {}): never {
  throw new EngineError("discovery_assessment_subject_invalid", `[${field}] ${reason}`, { field, reason, ...details });
}
function noveltyInvalid(field: string, reason: string, details: Record<string, unknown> = {}): never {
  throw new EngineError("discovery_novelty_invalid", `[${field}] ${reason}`, { field, reason, ...details });
}

/* ---------- addresses and keys ---------- */

/** The address of the progress state of one plan-question of one exact plan edition. */
export function v7ProgressStateId(subject: V7AssessmentSubject): string {
  return `v7-progress-state:${hashJson({ project: subject.project, planAnswer: canonical(subject.planAnswer),
    planQuestionId: subject.planQuestionId })}`;
}
/** The attempt accounting key (№7546 §1.2): one application of a result to one exact attempt of one plan-question —
 * a second assessment, an overlapping packet or a recovery of the same attempt never counts it again. */
export function attemptAccountKey(subject: V7AssessmentSubject, attempt: Ref): string {
  return `v7-attempt-account:${hashJson({ project: subject.project, planAnswer: canonical(subject.planAnswer),
    planQuestionId: subject.planQuestionId, attempt: canonical(attempt) })}`;
}
/** The progress event key (№7546 §1.2): the outer subject plus the inner content key — a new call, attempt or
 * assessment id with the same content is the same event. */
export function progressEventKey(subject: V7AssessmentSubject, contentKey: string): string {
  return `v7-progress-event:${hashJson({ project: subject.project, planAnswer: canonical(subject.planAnswer),
    planQuestionId: subject.planQuestionId, contentKey })}`;
}

/* ---------- the packet ---------- */

export interface ProvenPacketEntry {
  attempt: V7AttemptProof;
  /** The exact attempt binding K of the entry. */
  binding: Revision<ResearchAttemptBinding>;
  /** O@1 — the original managed turn; its number is the entry's position. */
  original: Revision<ManagedResearchTurn>;
  /** The managed turn revision completed through K. */
  completed: Revision<ManagedResearchTurn>;
  number: number;
}
export interface ProvenAttemptPacket {
  packet: V7AttemptPacket;
  /** The one research run of the draft the packet's turns belong to. */
  run: string;
  entries: ProvenPacketEntry[];
  planQuestion: V7PlanQuestion;
}

function subjectOf(value: Record<string, unknown>, at: string): V7AssessmentSubject {
  if (!nonempty(value["project"])) subjectInvalid(`${at}.project`, "the packet names its project");
  if (!isRef(value["planAnswer"])) subjectInvalid(`${at}.planAnswer`, "the packet names the exact plan answer");
  if (!nonempty(value["planQuestionId"])) subjectInvalid(`${at}.planQuestionId`, "the packet names its plan-question");
  return { project: value["project"], planAnswer: value["planAnswer"], planQuestionId: value["planQuestionId"] };
}

/** One entry: the DR3a2 attempt proof (its refusals keep their code), K proven by the K reader (its refusals keep
 * their code), the managed turn completed through exactly this K, and the subject of every part. */
function proveEntry(store: Store, subject: V7AssessmentSubject, entry: unknown, at: string):
  ProvenPacketEntry & { question: Ref } {
  if (!obj(entry) || !exactKeys(entry, ["attempt", "binding"]) || !isRef(entry["attempt"]) || !isRef(entry["binding"]))
    subjectInvalid(at, "a packet entry names exactly the attempt and its binding K");
  const attemptRef = entry["attempt"], bindingRef = entry["binding"];
  const attempt = proveAttempt(store, attemptRef);
  const value = attempt.attempt.value;
  if (value.project !== subject.project || !same(value.planAnswer, subject.planAnswer)
    || value.planQuestionId !== subject.planQuestionId)
    subjectInvalid(`${at}.attempt`, "the attempt belongs to another project, plan edition or plan-question",
      { ref: attemptRef });
  // Only a managed attempt enters a packet: the exact K of a turn of this project, read by the K reader.
  const raw = readExact<ResearchAttemptBinding>(store, bindingRef);
  if (raw === null || raw.kind !== ATTEMPT_BINDING_KIND || !obj(raw.value) || !isRef(raw.value.turn)
    || bindingRef.id !== attemptBindingId(subject.project, raw.value.turn.id))
    subjectInvalid(`${at}.binding`, "the attempt has no exact managed binding K of this project", { ref: bindingRef });
  const proven = readResearchAttemptBinding(store, subject.project, raw.value.turn.id);
  if (proven === null || !same(reference(proven.binding), bindingRef))
    subjectInvalid(`${at}.binding`, "the binding K is not the proven record of its turn", { ref: bindingRef });
  if (!same(proven.binding.value.attempt, attemptRef)
    || !same(proven.binding.value.planAnswer, subject.planAnswer)
    || proven.binding.value.planQuestionId !== subject.planQuestionId)
    subjectInvalid(`${at}.binding`, "the binding K records another attempt or subject", { ref: bindingRef });
  // K is written with the completed turn in one batch; the completed revision must name exactly this K.
  const completed = store.get<ManagedResearchTurn>(proven.pending.id, proven.pending.revision + 1);
  if (completed === null || !same(completed.value.attemptBinding ?? null, bindingRef)
    || completed.value.status !== "completed")
    subjectInvalid(`${at}.binding`, "the managed turn did not complete through this binding K", { ref: bindingRef });
  readResearchConsumerTurn(store, exactRef(completed));
  const question = proven.intent.value.question;
  if (!isRef(question)) subjectInvalid(`${at}.binding`, "the producing intent lost its Question basis");
  return { attempt, binding: proven.binding, original: proven.turn, completed, number: proven.turn.value.number,
    question };
}

/** The proven entries in the proven order: one run of the attempts' draft, one Question basis, unique attempts and
 * unique positions. The input order never decides the order. */
function proveEntries(store: Store, subject: V7AssessmentSubject, entries: unknown, at: string) {
  if (!Array.isArray(entries) || entries.length === 0)
    subjectInvalid(`${at}.entries`, "a packet holds at least one completed managed attempt");
  const proven = entries.map((entry, index) => proveEntry(store, subject, entry, `${at}.entries.${index}`));
  const attempts = new Set(proven.map(item => canonical(exactRef(item.attempt.attempt))));
  if (attempts.size !== proven.length) subjectInvalid(`${at}.entries`, "an attempt appears twice in one packet");
  const questions = new Set(proven.map(item => canonical(item.question)));
  if (questions.size !== 1) subjectInvalid(`${at}.question`, "the packet attempts name different Question bases");
  const runs = new Set(proven.map(item => item.original.value.run));
  if (runs.size !== 1) subjectInvalid(`${at}.run`, "the packet attempts belong to different research runs");
  const run = proven[0]!.original.value.run;
  const runRecord = store.get<{ projectId?: unknown; draftId?: unknown }>(run);
  if (runRecord === null || runRecord.kind !== "research-run" || runRecord.value.projectId !== subject.project
    || !proven.every(item => item.attempt.draft.id === runRecord.value.draftId))
    subjectInvalid(`${at}.run`, "the research run is not the run of the attempts' project and draft", { run });
  const positions = new Set(proven.map(item => item.number));
  if (positions.size !== proven.length)
    subjectInvalid(`${at}.order`, "two attempts claim one position of the run");
  proven.sort((a, b) => a.number - b.number);
  return { proven, run, question: proven[0]!.question };
}

/** Projects the packet value of the given entries in their proven order — a permutation of the input yields the
 * same packet. Structural: it names no paid assessment. */
export function projectAttemptPacket(store: Store, input: V7AssessmentSubject & { entries: V7AttemptPacketEntry[] }):
  V7AttemptPacket {
  const subject = subjectOf(input as unknown as Record<string, unknown>, "packet");
  const { proven, question } = proveEntries(store, subject, input.entries, "packet");
  return { contract: V7_ATTEMPT_PACKET_CONTRACT, project: subject.project, planAnswer: subject.planAnswer,
    planQuestionId: subject.planQuestionId, question,
    entries: proven.map(item => ({ attempt: exactRef(item.attempt.attempt), binding: exactRef(item.binding) })) };
}

/** Proves a saved packet: its exact form, every entry (attempt + K + completed turn) and the saved order equal to the
 * proven order. Absent, null, foreign or reordered packets are addressed refusals. */
export function proveAttemptPacket(store: Store, packet: unknown, at = "packet"): ProvenAttemptPacket {
  if (!obj(packet)) subjectInvalid(at, "the assessment names its attempts packet");
  if (!exactKeys(packet, ["contract", "project", "planAnswer", "planQuestionId", "question", "entries"])
    || packet["contract"] !== V7_ATTEMPT_PACKET_CONTRACT)
    subjectInvalid(at, "the packet carries exactly the v7-attempt-packet/v1 form");
  const subject = subjectOf(packet, at);
  if (!isRef(packet["question"])) subjectInvalid(`${at}.question`, "the packet names the real Question basis");
  const { proven, run, question } = proveEntries(store, subject, packet["entries"], at);
  if (!same(question, packet["question"]))
    subjectInvalid(`${at}.question`, "the packet names another Question than its producing intents");
  const saved = packet["entries"] as V7AttemptPacketEntry[];
  if (!proven.every((item, index) => same(saved[index]!.attempt, exactRef(item.attempt.attempt))))
    subjectInvalid(`${at}.order`, "the saved order is not the proven order of the managed turns");
  return { packet: packet as unknown as V7AttemptPacket, run, entries: proven,
    planQuestion: proven[0]!.attempt.planQuestion };
}

/* ---------- the baseline ---------- */

/** Proves the structure of a saved baseline: the state of THIS question — its exact present record or its explicit
 * absence at its own address — and unique, resolvable materials of this project. Whether a state's content is the
 * applied history is DR3b-P's; whether a material is accepted is proven where it is used. */
export function checkProgressBaseline(store: Store, baseline: unknown, subject: V7AssessmentSubject,
  at = "baseline"): V7ProgressBaseline {
  if (!obj(baseline)) subjectInvalid(at, "the assessment names its baseline");
  if (!exactKeys(baseline, ["contract", "state", "materials"]) || baseline["contract"] !== V7_PROGRESS_BASELINE_CONTRACT)
    subjectInvalid(at, "the baseline carries exactly the v7-progress-baseline/v1 form");
  const state = baseline["state"], stateId = v7ProgressStateId(subject);
  if (!obj(state)) subjectInvalid(`${at}.state`, "the baseline names the previous state or its explicit absence");
  if (state["kind"] === "absent") {
    if (!exactKeys(state, ["kind", "id"]) || state["id"] !== stateId)
      subjectInvalid(`${at}.state`, "the absent state is the address of this plan-question's own state");
  } else if (state["kind"] === "state") {
    if (!exactKeys(state, ["kind", "ref"]) || !isRef(state["ref"]) || state["ref"].id !== stateId)
      subjectInvalid(`${at}.state`, "the state is the exact record of this plan-question's own state");
    const record = readExact(store, state["ref"]);
    if (record === null || record.kind !== V7_PROGRESS_STATE_KIND)
      subjectInvalid(`${at}.state`, "the named state record is missing or changed", { ref: state["ref"] });
  } else subjectInvalid(`${at}.state`, "the state kind is absent or state");
  const materials = baseline["materials"];
  if (!Array.isArray(materials)) subjectInvalid(`${at}.materials`, "the baseline lists its accepted materials");
  const seen = new Set<string>();
  for (const [index, address] of materials.entries()) {
    resolveClaimAddress(store, address as ClaimAddress);
    if ((address as ClaimAddress).project !== subject.project)
      subjectInvalid(`${at}.materials.${index}`, "a material is a claim of this project", { address });
    const key = canonical(address);
    if (seen.has(key)) subjectInvalid(`${at}.materials.${index}`, "a material is listed twice", { address });
    seen.add(key);
  }
  return baseline as unknown as V7ProgressBaseline;
}

/** The guards an application of this baseline stands on: the explicit absence of the state, or its exact revision. */
export function baselineGuards(baseline: V7ProgressBaseline): TransactionGuard[] {
  return [baseline.state.kind === "absent" ? { id: baseline.state.id, absent: true }
    : { id: baseline.state.ref.id, revision: baseline.state.ref.revision, hash: baseline.state.ref.hash }];
}

/* ---------- the assessment form and its novelty ---------- */

const ASSESSMENT_FIELDS = ["contract", "projectId", "subject", "baseline", "session", "application", "assessor",
  "environment", "verdict", "reasons", "return", "novelty"] as const;
const NOVELTY_FIELDS = ["attempts", "accepted", "rejected", "newContent", "duplicates", "noProgress",
  "transition"] as const;

interface PacketClaim { address: ClaimAddress; entry: number; index: number }

/** The claim addresses of the packet's submitted attempts, in packet position order. */
function packetClaims(packet: ProvenAttemptPacket): PacketClaim[] {
  return packet.entries.flatMap((entry, position) => (entry.attempt.claims ?? []).map((claim, index) => ({
    address: { project: packet.packet.project, container: exactRef(entry.attempt.attempt),
      containerKind: V7_ATTEMPT_KIND, pointer: `/claims/${index}`,
      claimId: (claim as Record<string, Json>)["id"] as string },
    entry: position, index })));
}

function attemptRows(value: unknown, packet: ProvenAttemptPacket, field: string, every: boolean): string[] {
  if (!Array.isArray(value)) noveltyInvalid(field, "the classification lists its attempt rows");
  const members = new Set(packet.entries.map(entry => canonical(exactRef(entry.attempt.attempt))));
  const seen: string[] = [];
  for (const [index, row] of value.entries()) {
    if (!obj(row) || !exactKeys(row, ["attempt", "reason"]) || !isRef(row["attempt"]) || !nonempty(row["reason"]))
      noveltyInvalid(`${field}.${index}`, "an attempt row names exactly one exact attempt and its reason");
    const key = canonical(row["attempt"]);
    if (!members.has(key)) noveltyInvalid(`${field}.${index}`, "the attempt is not an element of the packet");
    if (seen.includes(key)) noveltyInvalid(`${field}.${index}`, "the attempt is classified twice");
    seen.push(key);
  }
  if (every && seen.length !== members.size) noveltyInvalid(field, "every packet attempt has exactly one row");
  return seen;
}

function claimRows(value: unknown, claims: Map<string, PacketClaim>, field: string,
  extra: readonly string[] = []): { key: string; row: Record<string, unknown> }[] {
  if (!Array.isArray(value)) noveltyInvalid(field, "the classification lists its claim rows");
  return value.map((row, index) => {
    if (!obj(row) || !exactKeys(row, ["claim", "reason", ...extra]) || !nonempty(row["reason"]))
      noveltyInvalid(`${field}.${index}`, "a claim row names exactly the claim address and its reason");
    const key = canonical(row["claim"]);
    if (!claims.has(key)) noveltyInvalid(`${field}.${index}`, "the claim is not a claim of a packet attempt");
    return { key, row };
  });
}

/** The machine-checkable completeness of the novelty (№7546 §1.3): absence, duplication or contradiction of the
 * classification is a typed refusal — never read as "nothing new". */
function checkNovelty(store: Store, novelty: unknown, packet: ProvenAttemptPacket, baseline: V7ProgressBaseline,
  verdict: "supported" | "return", requirements: boolean): V7Novelty {
  if (!obj(novelty)) noveltyInvalid("novelty", "an attempts assessment carries its novelty classification");
  if (!exactKeys(novelty, NOVELTY_FIELDS)) noveltyInvalid("novelty", "the novelty carries exactly its contracted parts");
  attemptRows(novelty["attempts"], packet, "novelty.attempts", true);
  const all = packetClaims(packet);
  const claims = new Map(all.map(item => [canonical(item.address), item]));
  const accepted = claimRows(novelty["accepted"], claims, "novelty.accepted");
  const rejected = claimRows(novelty["rejected"], claims, "novelty.rejected");
  const decided = [...accepted, ...rejected].map(item => item.key);
  if (new Set(decided).size !== decided.length)
    noveltyInvalid("novelty.accepted", "a claim is classified twice between accepted and rejected");
  if (decided.length !== claims.size)
    noveltyInvalid("novelty.accepted", "every claim of a submitted attempt is accepted or rejected");
  if (verdict === "return" && accepted.length > 0)
    noveltyInvalid("novelty.accepted", "a return accepts no claim");
  const acceptedKeys = new Set(accepted.map(item => item.key));
  const fresh = claimRows(novelty["newContent"], claims, "novelty.newContent");
  const duplicates = claimRows(novelty["duplicates"], claims, "novelty.duplicates", ["of"]);
  const split = [...fresh, ...duplicates].map(item => item.key);
  if (new Set(split).size !== split.length || split.length !== acceptedKeys.size
    || split.some(key => !acceptedKeys.has(key)))
    noveltyInvalid("novelty.newContent", "every accepted claim is exactly new content or a duplicate");
  const materials = new Set(baseline.materials.map(address => canonical(address)));
  for (const [index, { key, row }] of duplicates.entries()) {
    const of = canonical(row["of"]), at = claims.get(key)!, original = claims.get(of);
    const earlier = original !== undefined && acceptedKeys.has(of)
      && (original.entry < at.entry || original.entry === at.entry && original.index < at.index);
    if (!materials.has(of) && !earlier)
      noveltyInvalid(`novelty.duplicates.${index}.of`,
        "a duplicate names an accepted baseline material or an earlier accepted claim of this packet");
  }
  const transition = checkTransition(store, novelty["transition"], packet, verdict, acceptedKeys, materials, requirements);
  // An attempt progresses when one of its claims is new content, or when its proven constraint is a basis of the
  // proposed transition; every other attempt is exactly the noProgress set.
  const progressed = new Set<string>();
  for (const item of fresh) progressed.add(canonical(exactRef(packet.entries[claims.get(item.key)!.entry]!.attempt.attempt)));
  for (const basis of transition?.bases ?? [])
    if ("constraint" in basis) progressed.add(canonical(basis.constraint));
  const declared = new Set(attemptRows(novelty["noProgress"], packet, "novelty.noProgress", false));
  const expected = packet.entries.map(entry => canonical(exactRef(entry.attempt.attempt)))
    .filter(key => !progressed.has(key));
  if (declared.size !== expected.length || expected.some(key => !declared.has(key)))
    noveltyInvalid("novelty.noProgress", "noProgress names exactly the attempts without an acknowledged new basis");
  return novelty as unknown as V7Novelty;
}

function checkTransition(store: Store, value: unknown, packet: ProvenAttemptPacket, verdict: "supported" | "return",
  accepted: Set<string>, materials: Set<string>, requirements: boolean): V7QuestionTransition | null {
  if (value === null) return null;
  const at = "novelty.transition";
  if (verdict === "return") noveltyInvalid(at, "a return proposes no transition");
  if (!obj(value) || !exactKeys(value, ["outcome", "bases", "reason"], ["sufficiency", "consequence", "nextAction"]))
    noveltyInvalid(at, "a transition names its outcome, bases and reason");
  const outcome = value["outcome"];
  if (outcome !== "open" && outcome !== "closed" && outcome !== "unknown")
    noveltyInvalid(`${at}.outcome`, "the outcome is open, closed or unknown");
  if (!nonempty(value["reason"])) noveltyInvalid(`${at}.reason`, "a transition states its reason");
  const bases = value["bases"];
  if (!Array.isArray(bases) || bases.length === 0) noveltyInvalid(`${at}.bases`, "a transition names its exact bases");
  const seen = new Set<string>();
  for (const [index, basis] of bases.entries()) {
    const field = `${at}.bases.${index}`;
    if (obj(basis) && exactKeys(basis, ["claim"])) {
      const key = canonical(basis["claim"]);
      if (!accepted.has(key) && !materials.has(key))
        noveltyInvalid(field, "a claim basis is an accepted claim of this packet or a baseline material");
    } else if (obj(basis) && exactKeys(basis, ["constraint"]) && isRef(basis["constraint"])) {
      const entry = packet.entries.find(item => same(exactRef(item.attempt.attempt), basis["constraint"]));
      const end = entry?.attempt.attempt.value.end;
      if (end === undefined || (end.type !== "refused" && end.type !== "impossible"))
        noveltyInvalid(field, "a constraint basis is a refused or impossible attempt of this packet");
      if (end.evidence.length === 0) noveltyInvalid(field, "a constraint without evidence proves nothing new");
      if (outcome !== "unknown") noveltyInvalid(field, "a proven constraint grounds only an unknown outcome");
      // The declared new basis must carry an agreed semantic content (DR3b-M-01): its key is computable.
      constraintContentKey(store, basis["constraint"]);
    } else noveltyInvalid(field, "a basis is exactly a claim address or an attempt constraint");
    const key = canonical(basis);
    if (seen.has(key)) noveltyInvalid(field, "a basis is named twice");
    seen.add(key);
  }
  const plan = packet.planQuestion.question as Record<string, Json>;
  const sufficiency = value["sufficiency"];
  if (outcome === "closed") {
    // Closing needs the saved sufficiency decision against the accepted plan's own criterion and depth; the
    // assessor never changes them.
    if (!obj(sufficiency) || !exactKeys(sufficiency, ["criterion", "requiredDepth", "reason", ...(requirements ? ["methodologyRequirements"] : [])])
      || sufficiency["criterion"] !== plan["criterion"] || sufficiency["requiredDepth"] !== plan["requiredDepth"]
      || !nonempty(sufficiency["reason"]))
      noveltyInvalid(`${at}.sufficiency`, "closing states sufficiency against the plan's own criterion and depth");
    if (requirements) checkMethodologyRequirements(store, sufficiency["methodologyRequirements"],
      bases as V7QuestionTransition["bases"], packet.packet.project);
  } else if (sufficiency !== undefined) noveltyInvalid(`${at}.sufficiency`, "only a closing states sufficiency");
  const blocking = plan["class"] === "blocking";
  for (const key of ["consequence", "nextAction"] as const) {
    if (outcome === "unknown" && blocking && !nonempty(value[key]))
      noveltyInvalid(`${at}.${key}`, `an unknown of a blocking question states its ${key}`);
    if (value[key] !== undefined && (outcome !== "unknown" || !nonempty(value[key])))
      noveltyInvalid(`${at}.${key}`, `${key} belongs only to an unknown outcome`);
  }
  return value as unknown as V7QuestionTransition;
}

export interface CheckedAttemptsAssessment {
  value: VersionedDiscoveryAttemptsAssessment;
  packet: ProvenAttemptPacket;
  baseline: V7ProgressBaseline;
}

/** The structural reader of an attempts assessment form: the discriminator, the admitted subject kind, the proven
 * packet and baseline of the same subject, the named session/application/environment, the verdict with its return
 * target, and the complete novelty. It never stands for a paid assessment, an application or an accepted claim. */
export function checkDiscoveryAssessmentForm(store: Store, value: unknown): CheckedAttemptsAssessment {
  if (!obj(value)) subjectInvalid("assessment", "the assessment is an object");
  const requirements = value["contract"] === DISCOVERY_ASSESSMENT_CONTRACT_V3;
  const methodology = requirements || value["contract"] === DISCOVERY_ASSESSMENT_CONTRACT_V2;
  if (!methodology && value["contract"] !== DISCOVERY_ASSESSMENT_CONTRACT)
    subjectInvalid("contract", "the assessment carries a supported discovery-assessment discriminator");
  if (!exactKeys(value, methodology ? [...ASSESSMENT_FIELDS, "methodology"] : ASSESSMENT_FIELDS))
    subjectInvalid("assessment", "the assessment carries exactly its contracted fields");
  if (!nonempty(value["projectId"])) subjectInvalid("projectId", "the assessment names its project");
  const subject = value["subject"];
  if (!obj(subject)) subjectInvalid("subject", "the assessment names its subject");
  if (subject["kind"] !== "attempts")
    subjectInvalid("subject.kind", "only the attempts subject is admitted", { kind: subject["kind"] ?? null });
  if (!exactKeys(subject, ["kind", "packet"])) subjectInvalid("subject", "the attempts subject names exactly its packet");
  const packet = proveAttemptPacket(store, subject["packet"], "subject.packet");
  if (packet.packet.project !== value["projectId"])
    subjectInvalid("subject.packet.project", "the packet belongs to another project");
  const baseline = checkProgressBaseline(store, value["baseline"], packet.packet);
  for (const key of ["session", "application", "environment"] as const)
    if (!isRef(value[key])) subjectInvalid(key, `the assessment names its exact ${key}`);
  if (!nonempty(value["assessor"])) subjectInvalid("assessor", "the assessment names its assessor");
  const verdict = value["verdict"];
  if (verdict !== "supported" && verdict !== "return")
    noveltyInvalid("verdict", "an attempts assessment is supported or return");
  const reasons = value["reasons"];
  if (!Array.isArray(reasons) || reasons.length === 0 || !reasons.every(nonempty))
    noveltyInvalid("reasons", "the assessment states its reasons");
  const back = value["return"];
  if (verdict === "supported" && back !== null) noveltyInvalid("return", "a supported assessment sends nothing back");
  if (verdict === "return") {
    if (!obj(back) || !exactKeys(back, ["target", "reason"]) || !nonempty(back["reason"]) || !obj(back["target"]))
      noveltyInvalid("return", "a return names its target and reason");
    const target = back["target"];
    const attempts = packet.entries.map(entry => canonical(exactRef(entry.attempt.attempt)));
    const claims = packetClaims(packet).map(item => canonical(item.address));
    const lawful = exactKeys(target, ["attempt"]) ? attempts.includes(canonical(target["attempt"]))
      : exactKeys(target, ["claim"]) && claims.includes(canonical(target["claim"]));
    if (!lawful) noveltyInvalid("return.target", "a return target is one packet attempt or one of its claims");
  }
  const novelty = checkNovelty(store, value["novelty"], packet, baseline, verdict, requirements);
  if (methodology) checkAssessmentMethodology(store, value["methodology"], {
    project: packet.packet.project, planAnswer: packet.packet.planAnswer,
    planQuestionId: packet.packet.planQuestionId, blocking: (packet.planQuestion.question as Record<string, Json>)["class"] === "blocking",
    accepted: novelty.accepted.map(row => row.claim),
  }, requirements ? ASSESSMENT_METHODOLOGY_POLICY_V2 : ASSESSMENT_METHODOLOGY_POLICY);
  return { value: value as unknown as VersionedDiscoveryAttemptsAssessment, packet, baseline };
}

/* ---------- the content key (№7546 §1.4) ---------- */

/** N(text): NFC, CRLF/CR → LF, outer whitespace trimmed. Inner characters, case, numbers and punctuation are kept. */
export function normalizeClaimText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}
const sortedSet = (items: string[]) => [...new Set(items)].sort();

/** The accepted-premise proof an inference key needs. The default common
 * ClaimAddress reader proves historical answers or the exact accepted pointer
 * of an atomically applied attempt. Resolution or payment alone never suffices. */
export type PremiseAcceptance = (address: ClaimAddress) => void;
export interface ContentKeyOptions {
  premise?: PremiseAcceptance;
  /** The claim resolver; the structural ClaimAddress resolver by default. */
  resolve?: (address: ClaimAddress) => ResolvedClaim;
}

/** The semantic identity of a saved Source — origin kind, exact location, media type and the content hash of the
 * SAVED bytes (checked against them). A new capture, id or fetch time of the same material is the same identity. */
function sourceIdentity(store: Store, ref: unknown, project: string, field: string): {
  identity: Record<string, Json>; content: string } {
  if (!isRef(ref)) noveltyInvalid(field, "the source is an exact Ref");
  const source = readExact<Source>(store, ref);
  if (source === null || source.kind !== "source" || !obj(source.value) || source.value.projectId !== project
    || typeof source.value.content !== "string" || !obj(source.value.origin)
    || source.value.sha256 !== digest(source.value.content))
    noveltyInvalid(field, "the source is missing, foreign, changed or does not hash to its saved bytes", { ref });
  const origin = source.value.origin as { kind: string; location: string };
  return { content: source.value.content, identity: { origin: origin.kind, location: origin.location,
    mediaType: source.value.mediaType, sha256: source.value.sha256 } };
}

function keyOf(material: Record<string, Json>): string {
  return hashJson({ contract: DISCOVERY_CONTENT_KEY_CONTRACT, ...material });
}

function authorityRef(basis: Record<string, Json>): unknown {
  const authority = basis["authority"];
  return isRef(authority) ? authority : obj(authority) ? authority["ref"] : undefined;
}

/** The owner-decision content: only an exact, proven owner act — a v2 Discovery condition decision of the local owner
 * authority with its saved session and grant, or a variant owner act proven by its own door with its decision/state
 * pair (the semantic projection lives in variant-scope.ts). A grant, a session, a historical caller choice, a paid
 * model decision or any other record is not a performed owner act. */
function ownerActScope(store: Store, basis: Record<string, Json>, project: string, field: string): Record<string, Json> {
  const ref = authorityRef(basis);
  const record = isRef(ref) ? readExact<DiscoveryConditionDecision>(store, ref) : null;
  if (record === null)
    noveltyInvalid(field, "the authority is not a proven owner act", { ref: ref ?? null });
  if (record.kind === "discovery-variant-owner-decision") {
    try {
      return variantOwnerActContent(store, project, ref as Ref);
    } catch (error) {
      if (error instanceof EngineError)
        noveltyInvalid(field, "the authority is not a proven owner act", { ref: ref as Ref, cause: error.code });
      throw error;
    }
  }
  if (record.kind !== "discovery-condition-decision" || !obj(record.value)
    || record.value.contract !== "discovery-condition-decision/v2" || record.value.projectId !== project)
    noveltyInvalid(field, "the authority is not a proven owner act", { ref: ref ?? null });
  const value = record.value;
  let view: ReturnType<typeof readDiscoveryConditionDecision>;
  try {
    view = readDiscoveryConditionDecision(store, { project, draft: value.draftId, verdictRef: value.verdictRef,
      reportRef: value.reportRef, conditionId: value.conditionId, record: ref as Ref });
  } catch (error) {
    if (error instanceof EngineError)
      noveltyInvalid(field, "the authority is not a proven owner act", { ref: ref as Ref, cause: error.code });
    throw error;
  }
  if (view.authority !== "local-owner-authority")
    noveltyInvalid(field, "the authority is not a proven owner act", { ref: ref as Ref });
  return { project, draft: value.draftId, verdictRef: value.verdictRef as unknown as Json,
    reportRef: value.reportRef as unknown as Json, conditionId: value.conditionId, optionId: value.optionId };
}

/** The versioned content key of one claim. No claim, attempt, call or assessment id, transport revision, write time
 * or fetchedAt enters it. Fact: the Source identity, the range and the checked valueHash. Inference: N(text) and the
 * sorted keys of its proven accepted premises (cycles refused). Hypothesis/unknown: their normalized content.
 * Owner-decision: N(text) and the scope of the exact proven owner act. A different key is not by itself semantic
 * novelty — the event needs the assessor's acknowledgement too. */
export function claimContentKey(store: Store, address: ClaimAddress, options: ContentKeyOptions = {}): string {
  const premise = options.premise ?? (item => { proveClaimAddress(store, item); });
  const resolve = options.resolve ?? (item => resolveClaimAddress(store, item));
  // DR3b-M-02 (№7589): one calculation resolves, accepts and keys every distinct premise once — a shared accepted
  // subgraph is never walked again; a premise still being derived on the current path is a cycle.
  const derived = new Map<string, string>(), deriving = new Set<string>(), accepted = new Set<string>();
  const accept = (next: ClaimAddress) => {
    const at = canonical(next);
    if (!accepted.has(at)) { premise(next); accepted.add(at); }
  };
  const visit = (current: ClaimAddress): string => {
    const at = canonical(current);
    const known = derived.get(at);
    if (known !== undefined) return known;
    if (deriving.has(at)) noveltyInvalid("inference.from", "the premises form a cycle", { address: current });
    deriving.add(at);
    const key = derive(current);
    deriving.delete(at);
    derived.set(at, key);
    return key;
  };
  const derive = (current: ClaimAddress): string => {
    const claim = resolve(current).claim;
    if (!obj(claim) || typeof claim["kind"] !== "string" || typeof claim["text"] !== "string" || !obj(claim["basis"]))
      noveltyInvalid("claim", "the claim has no kind, text or basis", { address: current });
    const basis = claim["basis"] as Record<string, Json>, text = normalizeClaimText(claim["text"]);
    switch (claim["kind"]) {
      case "fact": {
        const pinned = basis["source"];
        if (!obj(pinned) || !obj(pinned["range"]))
          noveltyInvalid("fact.source", "a fact names its pinned source and range", { address: current });
        const { identity, content } = sourceIdentity(store, pinned["ref"], current.project, "fact.source");
        const start = pinned["range"]["start"], end = pinned["range"]["end"];
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
          || (end as number) <= (start as number) || (end as number) > content.length)
          noveltyInvalid("fact.range", "the range lies inside the saved source content", { address: current });
        if (pinned["valueHash"] !== hashJson(content.slice(start as number, end as number)))
          noveltyInvalid("fact.valueHash", "the valueHash is not the hash of the selected saved value", { address: current });
        return keyOf({ kind: "fact", source: identity, range: { start: start as number, end: end as number },
          valueHash: pinned["valueHash"] as string });
      }
      case "inference": {
        const from = basis["from"];
        const premises = Array.isArray(from) ? from : obj(from) ? [from] : [];
        if (premises.length === 0) noveltyInvalid("inference.from", "an inference follows from premises", { address: current });
        const keys = premises.map(item => {
          const next = item as unknown as ClaimAddress;
          if (deriving.has(canonical(next)))
            noveltyInvalid("inference.from", "the premises form a cycle", { address: next });
          accept(next);
          return visit(next);
        });
        return keyOf({ kind: "inference", text, premises: sortedSet(keys) });
      }
      case "hypothesis":
        if (typeof basis["howToVerify"] !== "string")
          noveltyInvalid("hypothesis", "a hypothesis states how it is verified", { address: current });
        return keyOf({ kind: "hypothesis", text, howToVerify: normalizeClaimText(basis["howToVerify"]) });
      case "unknown": {
        const affects = basis["affects"];
        if (!["question", "consumer", "closeCriterion"].every(key => typeof basis[key] === "string")
          || !Array.isArray(affects) || !affects.every(item => typeof item === "string")
          || typeof basis["blocksCurrentStage"] !== "boolean" || typeof basis["moment"] !== "string")
          noveltyInvalid("unknown", "an unknown carries its full form", { address: current });
        return keyOf({ kind: "unknown", text, question: normalizeClaimText(basis["question"] as string),
          consumer: normalizeClaimText(basis["consumer"] as string),
          closeCriterion: normalizeClaimText(basis["closeCriterion"] as string),
          affects: sortedSet((affects as string[]).map(normalizeClaimText)),
          blocksCurrentStage: basis["blocksCurrentStage"], moment: basis["moment"] });
      }
      case "owner-decision":
        return keyOf({ kind: "owner-decision", text, act: ownerActScope(store, basis, current.project, "owner-decision.authority") });
      default:
        return noveltyInvalid("claim.kind", "the claim kind has no content contract", { address: current });
    }
  };
  return visit(address);
}

/** DR3b-M-01 (№7589): the semantic content of one evidence record, by an explicit projector per supported kind — a
 * Source is its identity (origin kind, location, media type, hash of the saved bytes). Any other kind has no agreed
 * semantic contract yet: its whole-body hash would carry times, transport refs and other service fields, so it is
 * refused with the evidence address instead of standing for content. */
type EvidenceProjector = (store: Store, ref: Ref, project: string, field: string) => Json;
// DR3b-M-01 (№7601): a closed set of OWN entries — a Map, so a kind named like an inherited Object member
// (toString, valueOf, constructor, __proto__) never selects a projector.
const EVIDENCE_CONTENT: ReadonlyMap<string, EvidenceProjector> = new Map<string, EvidenceProjector>([
  ["source", (store, ref, project, field) => sourceIdentity(store, ref, project, field).identity],
]);
function evidenceContent(store: Store, ref: Ref, project: string, field: string): Json {
  const record = readExact<Record<string, Json>>(store, ref);
  if (record === null) noveltyInvalid(field, "the evidence is missing or changed", { ref });
  const projector = EVIDENCE_CONTENT.get(record.kind);
  if (projector === undefined)
    noveltyInvalid(field, `evidence of kind ${record.kind} has no semantic content contract`, { ref, kind: record.kind });
  return projector(store, ref, project, field);
}

/** The content key of the proven constraint of a refused/impossible attempt: its code and the proven content of its
 * evidence — never the attempt id or its text (a renamed refusal is not new). Empty evidence proves nothing new. */
export function constraintContentKey(store: Store, attempt: Ref): string {
  const proof = proveAttempt(store, attempt);
  const end = proof.attempt.value.end;
  if (end.type !== "refused" && end.type !== "impossible")
    noveltyInvalid("constraint", "only a refused or impossible attempt carries a constraint", { ref: attempt });
  if (end.evidence.length === 0)
    noveltyInvalid("constraint.evidence", "a constraint without evidence proves nothing new", { ref: attempt });
  const evidence = end.evidence.map((ref, index) =>
    canonical(evidenceContent(store, ref, proof.attempt.value.project, `constraint.evidence.${index}`)));
  return keyOf({ kind: "constraint", code: end.code, evidence: sortedSet(evidence) });
}

/** The content key of a question transition: from/to and the sorted keys of its NEW accepted bases. Without a new
 * basis there is no event — a status switch on old bases is not progress. */
export function transitionContentKey(from: string | null, to: string, baseKeys: string[]): string {
  if (baseKeys.length === 0) noveltyInvalid("transition.bases", "a transition event needs a new accepted basis");
  return keyOf({ kind: "transition", from, to, bases: sortedSet(baseKeys) });
}

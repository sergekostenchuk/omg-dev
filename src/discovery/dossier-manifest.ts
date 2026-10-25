import { withHistoricalReads, pendingSnapshotView } from '../history/proofs.js';
import { type DiscoveryDraft, type Question } from './discovery.js';
import type { ResearchAnswer, PaidDiscoveryAttemptsAssessment, V7ProgressApplication, V7AttemptAccount, V7ProgressState } from './research-model.js';
import { currentPlan, proveAttempt, provePlanQuestions } from './v7-plan-questions.js';
import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision, TransactionGuard } from '../storage/store.js';
import { resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import { decodeDossierContradictions, checkDossierContradictionEvidence, type DossierClassificationGrounds, type ProvenDossierContradiction, type DossierContradiction } from './dossier-contradictions.js';
import { V7_ATTEMPT_KIND, V7_AXES, V7_DEPTHS, V7_UNKNOWN_MOMENTS, V7_CLAIM_POINTER, discoveryAcceptanceActId, provenAcceptance, type DiscoveryAcceptanceAct, type V7Axis } from './v7-contracts.js';
import { readVariantHandoff } from './discovery-outcome.js';
import { readVariantSnapshot } from './variant-snapshot.js';
import { readVariantGeneration, readVariantModelDecision } from './variant-session.js';
import { readVariantOwnerDecision } from './discovery-decision.js';
import { variantStateId, type VariantHandoff } from './variant-decision.js';
import { readDiscoveryAssessment } from './research-assessment.js';
import { proveAppliedAttemptClassification, readV7ProgressStateAt } from './v7-progress.js';
import { readProjectMode } from '../product/project-mode.js';
import { uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { readResearchConsumerExecution, readResearchAttemptBinding, type ResearchConsumerIntent } from './response-recovery.js';
import { readAssessmentSessionOutcomeAt } from './assessment-session.js';
import { discoveryAssessmentId } from './research-consumer-transition.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { attemptBindingId, type ResearchAttemptBinding } from './v7-managed-attempt.js';
import { attemptAccountKey, v7ProgressStateId } from './v7-attempt-assessment.js';
import { proveIssuedAnswer, savedAcceptanceAct } from './projection-reader.js';

/** DR6 6.1 (codex-omg №9189, раздел DR6): the closed structural form of the
 * exact dossier snapshot of one v7 Discovery draft (D6, «манифест досье»). The
 * snapshot fixes the exact set of claims by axis and the addressed unknowns,
 * complete for a positive path or partial with its reasons on every path up to
 * the final (D7). Structural only: it proves its own immutable bytes and form,
 * never a paid producer, an accepted claim, an assessment or an acceptance —
 * a structural snapshot is not accepted and carries no acceptance fields.
 * Contradictions (6.2), the coverage semantics of complete/partial (6.3) and
 * the assessment of the snapshot (6.4–6.6) build on this form. */
export const DOSSIER_MANIFEST_KIND = 'discovery-dossier-manifest' as const;
export const DOSSIER_MANIFEST_CONTRACT = 'discovery-dossier-manifest/v1' as const;
/** The containers a v7 claim lives in — the two routes of resolveClaimAddress (ClaimAddress.containerKind). */
export const DOSSIER_CLAIM_CONTAINERS = Object.freeze(['research-answer', V7_ATTEMPT_KIND] as const);
/** The reasons a snapshot is partial (карта, ndisc.d6.n4): every variant rejected,
 * no grounded variant, the budget limit, no progress. */
export const DOSSIER_PARTIAL_REASONS = Object.freeze(['reject_all', 'no_variants', 'budget', 'stall'] as const);
export type DossierPartialReason = typeof DOSSIER_PARTIAL_REASONS[number];

export type DossierClaimAddress = ClaimAddress;
export interface DossierAxis { depth: typeof V7_DEPTHS[number]; reason: string | null; claims: DossierClaimAddress[] }
export interface DossierUnknown { claim: DossierClaimAddress; unknownId: string; consumer: string;
  moment: typeof V7_UNKNOWN_MOMENTS[number]; blocksCurrentStage: boolean }
export interface DossierReason { code: DossierPartialReason; message: string; grounds: Ref[] }
export interface DossierManifest {
  contract: typeof DOSSIER_MANIFEST_CONTRACT; projectId: string; draft: Ref; frame: Ref; plan: Ref;
  completeness: 'complete' | 'partial'; reasons: DossierReason[];
  axes: Record<V7Axis, DossierAxis>; unknowns: DossierUnknown[]; contradictions: DossierContradiction[];
}
export interface DossierRecordView { get<T = unknown>(id: string, revision?: number): Revision<T> | null }
/** A structural read result — deliberately not a proven or accepted dossier. */
export interface StructuralDossier { verification: 'structural'; record: Revision<DossierManifest> }

function invalid(field: string, message: string, code = 'discovery_dossier_invalid', ref?: Ref): never {
  throw new EngineError(code, `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as an acceptance mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed dossier form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the dossier form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value) || !/^[a-f0-9]{64}$/.test(value.hash)) invalid(at, 'Expected an exact reference');
}
function refs(value: unknown, at: string, minimum: number): asserts value is Ref[] {
  if (!Array.isArray(value) || value.length < minimum) invalid(at, minimum ? 'Expected a nonempty reference list' : 'Expected a reference list');
  value.forEach((item, i) => ref(item, `${at}.${i}`));
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate exact references');
}
function claimAddress(value: unknown, at: string, project: string): asserts value is DossierClaimAddress {
  shape(value, ['project', 'container', 'containerKind', 'pointer', 'claimId'], at);
  if (value.project !== project) invalid(`${at}.project`, 'A dossier claim belongs to the snapshot project');
  ref(value.container, `${at}.container`);
  if (!(DOSSIER_CLAIM_CONTAINERS as readonly unknown[]).includes(value.containerKind))
    invalid(`${at}.containerKind`, `A claim lives in ${DOSSIER_CLAIM_CONTAINERS.join(' or ')}`);
  if (typeof value.pointer !== 'string' || !V7_CLAIM_POINTER.test(value.pointer) || !Number.isSafeInteger(Number(value.pointer.slice(8))))
    invalid(`${at}.pointer`, 'A claim pointer is /claims/<index>');
  text(value.claimId, `${at}.claimId`);
}
const addressKey = (address: DossierClaimAddress) => canonical([address.container, address.pointer, address.claimId]);

/** The closed form of one snapshot. Every axis of the 12 is present: an
 * inapplicable axis keeps its reason and no claims; an investigated one has no
 * reason and, in a complete snapshot, at least one claim. A claim belongs to one
 * axis. Every unknown is addressed — what (its claim and id), to which consumer,
 * by which moment, whether it blocks the stage — and names a claim of the axes.
 * A complete snapshot has no partial reasons; a partial one names at least one,
 * each with its code, message and exact grounds. Contradictions keep both sides
 * by their full axis addresses (dossier-contradictions). An unknown contract is refused. */
export function decodeDossierManifest(value: unknown): DossierManifest {
  if (!object(value) || value.contract !== DOSSIER_MANIFEST_CONTRACT)
    invalid('contract', `Only ${DOSSIER_MANIFEST_CONTRACT} is a known dossier form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'draft', 'frame', 'plan', 'completeness', 'reasons', 'axes', 'unknowns', 'contradictions'], 'dossier');
  text(value.projectId, 'projectId');
  const project = value.projectId;
  ref(value.draft, 'draft'); ref(value.frame, 'frame'); ref(value.plan, 'plan');
  if (value.completeness !== 'complete' && value.completeness !== 'partial') invalid('completeness', 'A snapshot is complete or partial');
  const complete = value.completeness === 'complete';
  if (!Array.isArray(value.reasons)) invalid('reasons', 'Expected the list of partial reasons');
  if (complete && value.reasons.length) invalid('reasons', 'A complete snapshot has no partial reasons');
  if (!complete && !value.reasons.length) invalid('reasons', 'A partial snapshot names why it is partial');
  const codes = new Set<unknown>();
  value.reasons.forEach((reason: unknown, i: number) => {
    const at = `reasons.${i}`;
    shape(reason, ['code', 'message', 'grounds'], at);
    if (!(DOSSIER_PARTIAL_REASONS as readonly unknown[]).includes(reason.code))
      invalid(`${at}.code`, `A partial reason is one of ${DOSSIER_PARTIAL_REASONS.join(', ')}`);
    if (codes.has(reason.code)) invalid(`${at}.code`, 'Each partial reason is named once');
    codes.add(reason.code);
    text(reason.message, `${at}.message`); refs(reason.grounds, `${at}.grounds`, 1);
  });
  shape(value.axes, V7_AXES, 'axes');
  const axes = value.axes as Record<string, unknown>;
  const claims = new Map<string, DossierClaimAddress>();
  for (const axis of V7_AXES) {
    const at = `axes.${axis}`, entry = axes[axis];
    shape(entry, ['depth', 'reason', 'claims'], at);
    if (!(V7_DEPTHS as readonly unknown[]).includes(entry.depth)) invalid(`${at}.depth`, `A depth is one of ${V7_DEPTHS.join(', ')}`);
    if (!Array.isArray(entry.claims)) invalid(`${at}.claims`, 'Expected the list of the axis claims');
    if (entry.depth === 'inapplicable') {
      text(entry.reason, `${at}.reason`);
      if (entry.claims.length) invalid(`${at}.claims`, 'An inapplicable axis carries no claims');
    } else {
      if (entry.reason !== null) invalid(`${at}.reason`, 'Only an inapplicable axis carries a reason');
      if (complete && !entry.claims.length) invalid(`${at}.claims`, 'A complete snapshot has a claim on every investigated axis');
    }
    entry.claims.forEach((address: unknown, i: number) => {
      claimAddress(address, `${at}.claims.${i}`, project);
      const key = addressKey(address);
      if (claims.has(key)) invalid(`${at}.claims.${i}`, 'A claim belongs to one axis and is named once');
      claims.set(key, address);
    });
  }
  /** The identity key of a claim of the axes named by its full address, containerKind included (6.1-01). */
  const axisClaim = (address: unknown, at: string, whose: string): string => {
    claimAddress(address, at, project);
    const key = addressKey(address), named = claims.get(key);
    if (!named || canonical(named) !== canonical(address)) invalid(at, `${whose} names a claim of the snapshot axes by its full address`);
    return key;
  };
  if (!Array.isArray(value.unknowns)) invalid('unknowns', 'Expected the list of addressed unknowns');
  const unknownIds = new Set<unknown>(), unknownClaims = new Set<string>();
  value.unknowns.forEach((unknown: unknown, i: number) => {
    const at = `unknowns.${i}`;
    shape(unknown, ['claim', 'unknownId', 'consumer', 'moment', 'blocksCurrentStage'], at);
    const key = axisClaim(unknown.claim, `${at}.claim`, 'An unknown');
    if (unknownClaims.has(key)) invalid(`${at}.claim`, 'An unknown claim is listed once');
    unknownClaims.add(key);
    text(unknown.unknownId, `${at}.unknownId`);
    if (unknownIds.has(unknown.unknownId)) invalid(`${at}.unknownId`, 'Each unknown has its own id');
    unknownIds.add(unknown.unknownId);
    text(unknown.consumer, `${at}.consumer`);
    if (!(V7_UNKNOWN_MOMENTS as readonly unknown[]).includes(unknown.moment))
      invalid(`${at}.moment`, `A moment is one of ${V7_UNKNOWN_MOMENTS.join(', ')}`);
    if (typeof unknown.blocksCurrentStage !== 'boolean') invalid(`${at}.blocksCurrentStage`, 'An unknown states whether it blocks the stage');
  });
  decodeDossierContradictions(value.contradictions, { axisClaim: (address, at) => axisClaim(address, at, 'A side') });
  return structuredClone(value) as unknown as DossierManifest;
}

/** The canonical address of a snapshot: immutable, content-addressed, revision 1. */
export function dossierManifestId(value: { projectId: string }): string {
  return `${DOSSIER_MANIFEST_KIND}:${value.projectId}:${hashJson(value as never)}`;
}
/** The pure projector of a snapshot record — its closed form and its address.
 * Structural: the caller that writes it proves where its claims come from. */
export function projectDossierManifest(value: unknown): { id: string; value: DossierManifest } {
  const decoded = decodeDossierManifest(value);
  return { id: dossierManifestId(decoded), value: decoded };
}
/** The exact structural reader: the record at its exact Ref, of this kind and
 * project, at its canonical address and first revision, in the closed form.
 * Only immutable bytes are checked — the result is structural, not accepted. */
export function readDossierManifestStructural(view: DossierRecordView, project: string, at: Ref): StructuralDossier {
  ref(at, 'record');
  if (!view || typeof view.get !== 'function') invalid('view', 'An exact record reader is required');
  const row = view.get<unknown>(at.id, at.revision);
  if (!row || row.kind !== DOSSIER_MANIFEST_KIND || !Object.hasOwn(row, 'value') || canonical(reference(row)) !== canonical(at)
    || hashJson(row.value as never) !== at.hash)
    invalid('record', 'The exact record kind, revision or content hash does not match', 'discovery_dossier_invalid', at);
  const value = decodeDossierManifest(row.value);
  if (value.projectId !== project || row.id !== dossierManifestId(value) || row.revision !== 1)
    invalid('record', 'Foreign project or noncanonical snapshot address', 'discovery_dossier_invalid', at);
  return { verification: 'structural', record: { ...row, value } };
}


export interface ProvenDossierContradictions {
  verification: 'contradictions'; manifestRef: Ref; assessments: Ref[];
  record: Revision<DossierManifest>; contradictions: ProvenDossierContradiction[];
}
/** Proves only the presented contradictions against this exact manifest AND
 * this explicit assessment set. No manifest-only cache, writes, dispatch,
 * completeness decision or acceptance of the dossier is implied. */
export function readDossierContradictionsAt(store: Store, project: string, manifestRef: Ref,
  grounds: DossierClassificationGrounds): ProvenDossierContradictions {
  return withHistoricalReads(() => {
    const { record } = readDossierManifestStructural(store, project, manifestRef);
    const value = record.value, draft = store.get<DiscoveryDraft>(value.draft.id,value.draft.revision);
    if (!draft || draft.kind !== 'discovery-draft' || draft.hash !== value.draft.hash
      || hashJson(draft.value as never) !== draft.hash || draft.value.projectId !== project)
      invalid('draft','The snapshot needs its exact project draft');
    const questions = provePlanQuestions(store,draft,value.plan);
    const plan = store.get<ResearchAnswer>(value.plan.id,value.plan.revision)!;
    if (canonical((plan.value.value as Record<string,unknown>).frame) !== canonical(value.frame))
      invalid('frame','The snapshot frame is the frame of its exact proven plan');
    const contradictions = checkDossierContradictionEvidence(store,value,questions.map(q=>q.planQuestionId),grounds);
    return {verification:'contradictions',manifestRef:{...manifestRef},assessments:structuredClone(grounds.assessments),record,contradictions};
  });
}


/** 6.3-partial: proof of the three negative 4R.2 routes. This is neither a
 * completeness proof of a selected variant nor a dossier acceptance. */
export interface ProvenPartialDossier {
  verification: 'partial'; record: Revision<DossierManifest>; handoff: Revision<VariantHandoff>;
  materials: { claim: ClaimAddress; status: 'accepted' | 'rejected' | 'unassessed'; assessment: Ref | null }[];
  /** Applied classification grounds only; every paid MR also remains in record.reasons[].grounds. */
  assessments: Ref[]; contradictions: ProvenDossierContradiction[];
}

const dossierSame = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function dossierExact<T>(store: Store, at: Ref, kind?: string): Revision<T> {
  ref(at, 'grounds');
  const row = store.get<T>(at.id, at.revision);
  if (!row || kind && row.kind !== kind || !dossierSame(reference(row), at) || hashJson(row.value as never) !== row.hash)
    invalid('grounds', 'An exact dossier ground is missing or changed', 'discovery_dossier_invalid', at);
  return row;
}

/** The proven handoff fixes the temporal cut, not an assertion of acceptance.
 * Find its own immutable event with bounded queries, including gaps in the
 * journal. No current-head inventory or caller-supplied cursor is trusted. */
function handoffBoundary(store: Store, handoff: Ref): number {
  const last = store.lastEvent();
  let low = 1, high = last, found: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const event = store.eventsPage(middle - 1, last, 1)[0];
    if (!event) break;
    const row = store.getAtEvent(event.sequence, handoff.id, handoff.revision);
    if (row) { found = event.sequence; high = middle - 1; }
    else low = event.sequence + 1;
  }
  if (found === null || !dossierSame(store.eventAt(found), handoff))
    invalid('handoff', 'The exact handoff lost its committed boundary');
  return found;
}

/** The inventory is anchored in the saved snapshot applications, or the
 * exhausted ledger's paid calls before generation. No global current-head
 * scan can supply or remove material from this historical derivation. */
async function partialProjection(store: Store, project: string, handoffRef: Ref) {
  ref(handoffRef, 'handoff');
  const handoff = (await readVariantHandoff(store, project, handoffRef)).record, route = handoff.value;
  if (route.next !== 'dossier' || route.scope !== null || route.choice !== null
    || !['reject_all', 'no_variants', 'early_limit'].includes(route.reason)
    || route.reason === 'early_limit' && route.decision !== null)
    invalid('handoff', 'Only negative pre-choice dossier routes belong to this producer');
  const draft = dossierExact<DiscoveryDraft>(store, route.draft, 'discovery-draft');
  const questions = provePlanQuestions(store, draft, route.plan);
  const frame = dossierExact<ResearchAnswer>(store, route.frame, 'research-answer');
  proveDossierFrame(store, project, draft, route.frame);
  const grounds = new Map<string, Ref>([[canonical(handoffRef), handoffRef]]);
  const keep = (link: Ref) => { grounds.set(canonical(link), link); };
  const attempts = new Map<string, ReturnType<typeof proveAttempt>>();
  const assessments = new Map<string, Revision<PaidDiscoveryAttemptsAssessment>>();
  function attempt(link: Ref) {
    const proof = proveAttempt(store, link), value = proof.attempt.value;
    if (value.project !== project || value.draft.id !== draft.id || !dossierSame(value.planAnswer, route.plan)
      || !questions.some(q => q.planQuestionId === value.planQuestionId)) invalid('materials', 'Material belongs to another draft or exact plan');
    attempts.set(canonical(link), proof); keep(link);
  }
  function assessment(link: Ref) {
    if (assessments.has(canonical(link))) return;
    const paid = readDiscoveryAssessment(store, project, link), packet = paid.value.subject.packet;
    if (!dossierSame(packet.planAnswer, route.plan) || !questions.some(q => q.planQuestionId === packet.planQuestionId))
      invalid('assessments', 'The paid classification belongs to another exact plan');
    assessments.set(canonical(link), paid); keep(link);
    for (const entry of packet.entries) { attempt(entry.attempt); keep(entry.binding); }
  }
  if (route.snapshot) {
    const snapshot = readVariantSnapshot(store, project, route.snapshot); keep(route.snapshot);
    for (const question of snapshot.value.questions) {
      if (question.progress) keep(question.progress);
      for (const link of question.applications) {
        const application = dossierExact<V7ProgressApplication>(store, link, 'v7-progress-application');
        keep(link); assessment(application.value.assessment);
      }
    }
  }
  if (route.stop) {
    for (const link of route.stop.grounds) {
      keep(link);
      const row = dossierExact<ModelCall>(store, link);
      if (row.kind !== 'model-call') continue;
      if (row.value.consumerIntent) {
        const terminal = store.history<ResearchConsumerIntent>(row.value.consumerIntent.id)
          .find(r => r.value.call?.id === row.id && ['applied', 'refused'].includes(r.value.state));
        if (!terminal) invalid('budget', 'The paid call lost its terminal consumer');
        const view = pendingSnapshotView(store, [terminal]);
        readResearchConsumerExecution(view, project, reference(terminal)); keep(reference(terminal));
        for (const output of terminal.value.outputs ?? []) {
          const saved = dossierExact(store, output);
          if (saved.kind === V7_ATTEMPT_KIND) attempt(output);
          if (saved.kind === 'research-turn') {
            const bindingId = attemptBindingId(project, saved.id), binding = store.get<ResearchAttemptBinding>(bindingId, 1);
            if (binding) {
              const bound = readResearchAttemptBinding(pendingSnapshotView(store, [binding]), project, saved.id);
              if (!bound) invalid('materials', 'The paid turn lost its attempt binding');
              if (dossierSame(bound.attempt.value.planAnswer, route.plan)) { attempt(reference(bound.attempt)); keep(reference(binding)); }
            }
          }
        }
      } else if (row.value.assessmentApplication) {
        const application = store.history<{ state: string; call: Ref | null; after: Ref | null }>(row.value.assessmentApplication.id)
          .find(r => r.value.state === 'applied' && r.value.call?.id === row.id && r.value.after);
        if (!application?.value.after) invalid('budget', 'The paid assessor lost its terminal application');
        const proof = readAssessmentSessionOutcomeAt(store, project, application.value.after, reference(application));
        keep(reference(application)); keep(application.value.after);
        const subject = proof.context.assessmentSubject;
        if (subject?.packet && dossierSame(subject.packet.planAnswer, route.plan)) {
          const id = discoveryAssessmentId({ projectId: project, contract: subject.assessment.contract,
            session: proof.session, application: proof.application });
          const paid = store.get<PaidDiscoveryAttemptsAssessment>(id, 1);
          if (!paid) invalid('assessments', 'The paid packet result has not been published');
          assessment(reference(paid));
        }
      }
    }
  }
  const material = projectDossierMaterials(store, project, draft, frame, route.plan,
    [...attempts.values()].map(p => reference(p.attempt)), [...assessments.values()].map(reference),
    route.stop ? handoffBoundary(store, handoffRef) : null);
  for (const link of material.grounds) keep(link);
  const { materials, axes, unknowns } = material;
  const code = route.reason === 'early_limit' ? 'budget' : route.reason as 'reject_all' | 'no_variants';
  const value = decodeDossierManifest({ contract: DOSSIER_MANIFEST_CONTRACT, projectId: project, draft: route.draft,
    frame: route.frame, plan: route.plan, completeness: 'partial', reasons: [{ code,
      message: route.stop?.message ?? `The proven variant handoff ends with ${code}`,
      grounds: [handoffRef, ...[...grounds.values()].filter(r => !dossierSame(r, handoffRef)).sort((a,b) => canonical(a).localeCompare(canonical(b)))] }],
    axes, unknowns, contradictions: material.contradictions });
  const refs = material.assessments;
  const contradictions = checkDossierContradictionEvidence(store, value, questions.map(q => q.planQuestionId), { assessments: refs });
  return { value, handoff, materials, assessments: refs, contradictions };
}

/** The common accepted-frame proof for either dossier route. */
export function proveDossierFrame(store: Store, project: string, draft: Revision<DiscoveryDraft>, frameRef: Ref): Revision<ResearchAnswer> {
  const frame = dossierExact<ResearchAnswer>(store, frameRef, 'research-answer');
  const acceptance = store.get<DiscoveryAcceptanceAct>(discoveryAcceptanceActId(project, draft.id, 'frame', frameRef), 1);
  if (!acceptance || !isRef(acceptance.value.questionAfter)) invalid('frame', 'The exact frame has no saved acceptance');
  const question = dossierExact<Question>(store, acceptance.value.questionAfter, 'question');
  if (!savedAcceptanceAct(store, draft, question, 'frame', frameRef, frame.value.value))
    invalid('frame', 'The frame does not belong to this exact draft');
  const issued = proveIssuedAnswer(store, draft, { question, foreign: false, answered: true, answerRef: frameRef, field: 'frame' },
    frame as unknown as Revision<Record<string, Json>>, { verifyIssuedQuestion: true });
  if (!issued.ok || !provenAcceptance(issued.proof.provenance)) invalid('frame', 'The frame has no proven accepted origin');
  return frame;
}

/** Common 6.3 material projection. Paid MR and applied classifications remain
 * distinct; both sides of explicit relations and addressed unknowns survive. */
export function projectDossierMaterials(store: Store, project: string, draft: Revision<DiscoveryDraft>,
  frame: Revision<ResearchAnswer>, plan: Ref, attemptRefs: Ref[], assessmentRefs: Ref[], boundary: number | null) {
  const questions = provePlanQuestions(store, draft, plan);
  const grounds = new Map<string, Ref>();
  const keep = (link: Ref) => { grounds.set(canonical(link), link); };
  const attempts = new Map<string, ReturnType<typeof proveAttempt>>();
  const assessments = new Map<string, Revision<PaidDiscoveryAttemptsAssessment>>();
  function attempt(link: Ref) {
    if (attempts.has(canonical(link))) return;
    const proof = proveAttempt(store, link), value = proof.attempt.value;
    if (value.project !== project || value.draft.id !== draft.id || !dossierSame(value.planAnswer, plan)
      || !questions.some(q => q.planQuestionId === value.planQuestionId)) invalid('materials', 'Material belongs to another draft or exact plan');
    if (boundary !== null && !store.getAtEvent(boundary, link.id, link.revision)) invalid('materials', 'Material lies beyond the saved cut');
    attempts.set(canonical(link), proof); keep(link);
  }
  for (const link of attemptRefs) attempt(link);
  for (const link of assessmentRefs) {
    const paid = readDiscoveryAssessment(store, project, link), packet = paid.value.subject.packet;
    if (!dossierSame(packet.planAnswer, plan) || !questions.some(q => q.planQuestionId === packet.planQuestionId))
      invalid('assessments', 'The paid classification belongs to another exact plan');
    assessments.set(canonical(link), paid); keep(link);
    for (const entry of packet.entries) { attempt(entry.attempt); keep(entry.binding); }
  }
  const materials: ProvenPartialDossier['materials'] = [];
  // MR is paid evidence even before P. Only P present at the saved handoff
  // classifies material; a later recovery must not rewrite this exact cut.
  if (boundary !== null) {
    const states = new Set<string>();
    for (const paid of assessments.values()) {
      const id = v7ProgressStateId(paid.value.subject.packet);
      if (states.has(id)) continue;
      states.add(id);
      const state = store.getAtEvent<V7ProgressState>(boundary, id);
      if (state) {
        readV7ProgressStateAt(store, reference(state));
        keep(reference(state));
      }
    }
  }
  const classifications = new Map<string, Ref>();
  // Preserve every submitted claim, including rejected and unassessed ones.
  // Explicit cross-container links retain their other side as well.
  const claimMap = new Map<string, { address: ClaimAddress; value: Record<string, unknown> }>();
  const addClaim = (address: ClaimAddress) => {
    if (claimMap.has(canonical(address))) return;
    if (address.project !== project || address.containerKind !== V7_ATTEMPT_KIND) invalid('materials', 'This partial route retains its own v7 attempt claims');
    attempt(address.container);
    const value = resolveClaimAddress(store, address).claim;
    if (!object(value)) invalid('materials', 'The submitted material is not a claim');
    claimMap.set(canonical(address), { address, value });
  };
  for (const proof of attempts.values()) for (const [index, claim] of (proof.claims ?? []).entries())
    addClaim({ project, container: reference(proof.attempt), containerKind: V7_ATTEMPT_KIND,
      pointer: `/claims/${index}`, claimId: (claim as Record<string, Json>).id as string });
  for (const item of claimMap.values()) for (const key of ['contradicts', 'refutedBy'] as const)
    for (const target of (item.value[key] ?? []) as ClaimAddress[]) addClaim(target);
  for (const { address } of claimMap.values()) {
    const declared = [...assessments.values()].some(paid => [...paid.value.novelty.accepted, ...paid.value.novelty.rejected]
      .some(entry => dossierSame(entry.claim, address)));
    const attempt = attempts.get(canonical(address.container))!.attempt.value;
    const accountId = attemptAccountKey(attempt, address.container);
    const account = boundary === null ? store.get<V7AttemptAccount>(accountId, 1)
      : store.getAtEvent<V7AttemptAccount>(boundary, accountId, 1);
    if (!declared || !account && boundary !== null)
      materials.push({ claim: address, status: 'unassessed', assessment: null });
    else {
      // An existing but broken account/application is an error, never unassessed.
      const proof = proveAppliedAttemptClassification(store, address), exact = reference(proof.assessment);
      if (!assessments.has(canonical(exact))) invalid('assessments', 'The original classification is absent from the saved route');
      if (account) keep(reference(account));
      keep(reference(proof.application)); classifications.set(canonical(exact), exact);
      materials.push({ claim: address, status: proof.status, assessment: exact });
    }
  }
  materials.sort((a,b) => canonical(a.claim).localeCompare(canonical(b.claim)));
  const axes = Object.fromEntries(V7_AXES.map(axis => {
    const entry = (frame.value.value as Record<string, any>).axes[axis];
    // These are the frame's requested depths, not an assertion of sufficient coverage.
    return [axis, { depth: entry.depth, reason: entry.depth === 'inapplicable' ? entry.reason : null,
      claims: materials.filter(m => claimMap.get(canonical(m.claim))!.value.axis === axis).map(m => m.claim) }];
  })) as DossierManifest['axes'];
  const unknowns = materials.flatMap(m => {
    const value = claimMap.get(canonical(m.claim))!.value;
    if (value.kind !== 'unknown') return [];
    const basis = value.basis as Omit<DossierUnknown, 'claim'>;
    return [{ claim: m.claim, unknownId: basis.unknownId, consumer: basis.consumer, moment: basis.moment, blocksCurrentStage: basis.blocksCurrentStage }];
  });
  const pairs = new Map<string, DossierContradiction>();
  for (const m of materials) for (const link of ['contradicts', 'refutedBy'] as const) {
    const value = claimMap.get(canonical(m.claim))!.value;
    for (const target of (value[link] ?? []) as ClaimAddress[]) {
      const other = materials.find(c => dossierSame(c.claim, target));
      if (!other) invalid('contradictions', 'The exact other side is missing');
      const relation = link === 'contradicts' ? 'contradicts' : 'refutes';
      const sides = (link === 'refutedBy' ? [other, m] : [m, other].sort((a,b) => canonical(a.claim).localeCompare(canonical(b.claim)))) as DossierContradiction['sides'];
      const key = canonical([relation, ...sides.map(s => s.claim)]);
      const ids = [...new Set(sides.flatMap(s => (claimMap.get(canonical(s.claim))!.value.planQuestions as { planQuestionId: string }[]).map(q => q.planQuestionId)))].sort();
      pairs.set(key, { id: `contradiction:${hashJson(key)}`, relation, sides,
        reason: `Saved explicit ${link} relation; no semantic resolution is inferred`, planQuestionIds: ids,
        blocking: questions.some(q => ids.includes(q.planQuestionId) && (q.question as Record<string, Json>).class === 'blocking'), resolution: { state: 'open' } });
    }
  }
  return { materials, axes, unknowns, contradictions: [...pairs.values()].sort((a,b) => a.id.localeCompare(b.id)),
    assessments: [...classifications.values()].sort((a,b) => canonical(a).localeCompare(canonical(b))), grounds: [...grounds.values()] };
}

export async function readPartialDossier(store: Store, project: string, at: Ref): Promise<ProvenPartialDossier> {
  const record = readDossierManifestStructural(store, project, at).record;
  for (const reason of record.value.reasons) for (const ground of reason.grounds) dossierExact(store, ground);
  const link = record.value.reasons[0]?.grounds[0];
  if (!link) invalid('handoff', 'A partial dossier fixes its exact proven handoff');
  const proof = await partialProjection(store, project, link);
  if (!dossierSame(record.value, proof.value)) invalid('manifest', 'The saved partial dossier differs from its exact route and complete material inventory');
  return { verification: 'partial', record, handoff: proof.handoff, materials: proof.materials,
    assessments: proof.assessments, contradictions: proof.contradictions };
}

function partialCurrentGuards(store: Store, project: string, proof: Awaited<ReturnType<typeof partialProjection>>): TransactionGuard[] {
  const value = proof.handoff.value, plan = currentPlan(store, project);
  const stale = (field: string): never => invalid(field, 'The partial dossier route is no longer current', 'discovery_dossier_stale');
  if (!dossierSame(reference(plan.draft), value.draft) || !dossierSame(plan.planAnswer, value.plan)) stale('plan');
  const frame = dossierExact<ResearchAnswer>(store, value.frame, 'research-answer');
  const question = store.get<Question>(frame.value.question);
  if (!question || question.kind !== 'question' || question.value.draftId !== plan.draft.id || question.value.projectId !== project
    || !plan.draft.value.questions.includes(question.id) || question.value.spec.field !== 'frame' || question.value.status !== 'answered'
    || !dossierSame(question.value.answer, value.frame)) stale('frame');
  let selection: Ref | null = null, modeRef: Ref | null = null;
  if (value.result) {
    const generation = readVariantGeneration(store, project, value.result);
    selection = generation.state; modeRef = generation.session.value.variantSubject.mode;
  }
  if (value.decision) {
    if (store.get(value.decision.id, value.decision.revision)?.kind === 'discovery-variant-owner-decision') {
      const choice = readVariantOwnerDecision(store, project, value.decision);
      selection = reference(choice.state); modeRef = choice.decision.value.mode;
    } else {
      const choice = readVariantModelDecision(store, project, value.decision);
      selection = choice.state; modeRef = choice.decision.value.mode;
    }
  }
  const modeId = `project-mode:${project}`, beforeFirstMode = value.reason === 'early_limit' && value.result === null
    && store.history(modeId).length === 0;
  const mode = beforeFirstMode ? null : readProjectMode(store, project);
  if (modeRef && (!mode || !dossierSame(mode.ref, modeRef))) stale('mode');
  const stateId = variantStateId(project, plan.draft.id), state = store.get(stateId);
  if (selection ? !state || !dossierSame(reference(state), selection) : state || store.history(stateId).length) stale('selection');
  const guards: TransactionGuard[] = [reference(proof.handoff), reference(plan.draft), reference(plan.question), reference(question!), value.frame, value.plan,
    mode ? mode.ref : { id: modeId, absent: true }, state ? reference(state) : { id: stateId, absent: true }];
  if (value.stop) guards.push(...value.stop.grounds);
  for (const link of [value.snapshot, value.result, value.decision]) if (link) guards.push(link);
  if (!transactionGuardsCurrent(store, guards)) stale('guards');
  return uniqueTransactionGuards(guards);
}

/** Replay is a historical fixed point, never a new admission or payment. */
export async function producePartialDossier(store: Store, project: string, handoff: Ref): Promise<ProvenPartialDossier & { repeated: boolean }> {
  const proof = await partialProjection(store, project, handoff), id = dossierManifestId(proof.value), existing = store.get(id, 1);
  if (existing) return { ...(await readPartialDossier(store, project, reference(existing))), repeated: true };
  const guards = partialCurrentGuards(store, project, proof);
  const record = store.writeMany<DossierManifest>([{ id, kind: DOSSIER_MANIFEST_KIND, expected: 0, value: proof.value }], guards)[0]!;
  return { verification: 'partial', record, handoff: proof.handoff, materials: proof.materials,
    assessments: proof.assessments, contradictions: proof.contradictions, repeated: false };
}

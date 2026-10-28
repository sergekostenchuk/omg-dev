import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { CONDITION_RESOLUTION_EVIDENCE_CONTRACT, FINAL_ACCEPTANCE_ACT_KIND, FINAL_MACHINE_ADMISSION_KIND, acceptanceWrites,
  finalAcceptanceActId, finalMachineAdmissionId, proveFinalAcceptanceAct, proveFinalMachineAdmission, provenAcceptanceGrounds,
  readAcceptedDiscoveryBasisAt, type AcceptedDiscovery, type EditionResolution, type EvidenceConditionResolution,
  type FinalAcceptanceAct, type FinalMachineAdmission, type PositiveConditionResolution } from './discovery-acceptance.js';
import type { DiscoveryFinalAssessmentAddress, DiscoveryFinalAssessmentResult } from './discovery-final-assessment-result.js';
import { readDiscoveryFinalAssessmentPaidResultAt } from './discovery-final-assessment-execution.js';
import { readDiscoveryFinalAssessmentSourceAt, type DiscoveryFinalAssessmentSource } from './discovery-final-assessment-source.js';
import { readConditionEvidencePaidResultAt } from './discovery-condition-evidence-execution.js';
import type { FinalBundleContract, V7FinalBundle } from './v7-final-contracts.js';

/** OMG-V7-C4 (codex-omg2 №16923, ndisc.d8.n1): the owner's readable summary of any saved D7 outcome — go, conditional,
 * no_go, insufficient_evidence. It selects and arranges only what the shared proof readers prove from one exact Ref: the
 * paid D7 result, its paid assessment, or one exact accepted edition (choice/v2 and evidence/v3 included). It writes
 * nothing, invents no reason or route, never follows a head instead of the named edition, and states the acceptance of
 * the bundle beside its outcome: awaiting the owner, a decline, a return or a negative outcome permit no next stage. */
export const DISCOVERY_FINAL_SUMMARY = 'discovery-final-summary/v1' as const;

export type DiscoveryFinalSummaryRequest = { manifest: Ref } | { assessment: Ref } | { paid: Ref };
/** A pointer into the value of one exact saved record. */
export interface FinalSummaryAddress { record: Ref; pointer: string }
export interface FinalSummaryValue<T> { address: FinalSummaryAddress; value: T }
export interface FinalSummaryResolution {
  record: Ref; kind: 'owner_choice' | 'evidence';
  /** owner_choice: the chosen option and the owner's reason, from the saved positive resolution. */
  option: Json | null; reason: string | null;
  /** evidence: the exact paid evidence assessment and its reasons and bases. */
  evidence: Ref | null; reasons: string[]; bases: Json[];
}
export interface FinalSummaryCondition {
  id: string; kind: string; address: FinalSummaryAddress; condition: Json;
  /** open/resolved on an accepted edition; pending before any acceptance. */
  status: 'open' | 'resolved' | 'pending'; resolution: FinalSummaryResolution | null;
}
export interface FinalSummaryAssessment {
  record: Ref; verdict: 'supported' | 'return'; reasons: string[];
  bases: DiscoveryFinalAssessmentAddress[];
  return: { reason: string; targets: DiscoveryFinalAssessmentAddress[]; bases: DiscoveryFinalAssessmentAddress[] } | null;
}
export type FinalSummaryAcceptance =
  | { state: 'unassessed' }
  | { state: 'returned'; assessment: Ref }
  | { state: 'awaiting_decision'; assessment: Ref }
  | { state: 'declined'; assessment: Ref; act: Ref; reason: string }
  | { state: 'accepted'; assessment: Ref; manifest: Ref; previous: Ref | null; admission: { kind: 'owner' | 'machine'; record: Ref };
      reason: string | null; resolutions: Ref[] };
export type FinalSummaryNext =
  | { action: 'return'; reason: string; targets: DiscoveryFinalAssessmentAddress[] }
  | { action: 'owner_decision'; assessment: Ref }
  | { action: 'resolve_conditions'; manifest: Ref; open: { conditionId: string; address: FinalSummaryAddress }[] }
  | { action: 'consume_accepted'; manifest: Ref };
export interface DiscoveryFinalSummary {
  contract: typeof DISCOVERY_FINAL_SUMMARY; project: string;
  basis: { kind: 'manifest' | 'assessment' | 'paid'; record: Ref };
  paid: Ref; form: FinalBundleContract; outcome: V7FinalBundle['verdict']['outcome'];
  reason: FinalSummaryValue<string>;
  summary: FinalSummaryValue<V7FinalBundle['summary']>;
  projection: FinalSummaryValue<Json> | null; constitution: FinalSummaryValue<Json> | null;
  selectedVariant: { member: FinalSummaryValue<Json>; set: Ref | null; decision: FinalSummaryValue<Json> | null } | null;
  /** v9: constraints, risks and unknowns of the structural projection; v7/v8: its rules, external systems and unresolved. */
  material: FinalSummaryValue<Json>[];
  conditions: FinalSummaryCondition[];
  assessment: FinalSummaryAssessment | null;
  acceptance: FinalSummaryAcceptance;
  /** The next action or return, only when a saved result proves its address; null otherwise (a negative bundle). */
  next: FinalSummaryNext | null;
  /** True only for an accepted positive edition without open conditions. */
  permitsNextStage: boolean;
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never {
  throw new EngineError('discovery_final_summary_invalid', message, { field: 'request' });
}
const exactRef = (value: unknown): value is Ref => isRef(value) && plain(value) && Object.keys(value).sort().join(',') === 'hash,id,revision';
const exact = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });

/** One plain JSON snapshot of the request, read once: exactly one of manifest, assessment or paid, an exact Ref. */
export function decodeDiscoveryFinalSummaryRequest(value: unknown): { kind: 'manifest' | 'assessment' | 'paid'; ref: Ref } {
  let input: unknown;
  try { input = JSON.parse(canonical(value as never)); } catch { invalid('A final summary request is a plain JSON value'); }
  if (!plain(input) || Object.keys(input).length !== 1) invalid('A final summary names exactly one of manifest, assessment or paid');
  const [kind] = Object.keys(input) as ('manifest' | 'assessment' | 'paid')[];
  if (!['manifest', 'assessment', 'paid'].includes(kind!) || !exactRef(input[kind!])) invalid('A final summary names one exact Ref');
  return { kind: kind!, ref: exact(input[kind!] as Ref) };
}

const BUNDLE = '/projection/result/bundle';
function located<T>(paid: Ref, pointer: string, value: T): FinalSummaryValue<T> {
  return { address: { record: exact(paid), pointer: `${BUNDLE}${pointer}` }, value: structuredClone(value) };
}
function routeValue(entry: { ref: Ref; value: unknown } | null | undefined): FinalSummaryValue<Json> | null {
  return entry ? { address: { record: exact(entry.ref), pointer: '' }, value: structuredClone(entry.value) as Json } : null;
}
function material(paid: Ref, bundle: V7FinalBundle): FinalSummaryValue<Json>[] {
  const projection = bundle.projection as Record<string, unknown> | null;
  if (!projection) return [];
  const keys = Object.hasOwn(projection, 'constraints') ? ['constraints', 'risks', 'unknowns'] : ['rules', 'externalSystems', 'unresolved'];
  return keys.map(key => located(paid, `/projection/${key}`, projection[key] as Json));
}
function assessmentOf(record: Ref, result: DiscoveryFinalAssessmentResult): FinalSummaryAssessment {
  return { record: exact(record), verdict: result.verdict, reasons: [...result.reasons], bases: structuredClone(result.bases),
    return: result.return ? structuredClone(result.return) : null };
}
async function resolutionOf(store: Store, project: string, row: Revision<EditionResolution>): Promise<FinalSummaryResolution> {
  if (row.value.contract === CONDITION_RESOLUTION_EVIDENCE_CONTRACT) {
    const value = row.value as EvidenceConditionResolution;
    const paid = await readConditionEvidencePaidResultAt(store, project, value.evidence);
    const result = paid.result?.result;
    return { record: reference(row), kind: 'evidence', option: null, reason: null, evidence: exact(value.evidence),
      reasons: result ? [...result.reasons] : [], bases: result ? structuredClone(result.bases) as Json[] : [] };
  }
  const value = row.value as PositiveConditionResolution;
  return { record: reference(row), kind: 'owner_choice', option: structuredClone(value.option) as unknown as Json,
    reason: value.scope.reason, evidence: null, reasons: [], bases: [] };
}

/** The proven acceptance of one supported assessment: the saved owner act or machine admission of exactly it and the
 * first edition it publishes, or no decision yet. A decline publishes nothing. */
async function acceptanceOf(store: Store, project: string, assessment: Ref):
  Promise<{ acceptance: FinalSummaryAcceptance; accepted: AcceptedDiscovery | null }> {
  const grounds = await provenAcceptanceGrounds(store, project, assessment);
  const act = store.get<FinalAcceptanceAct>(finalAcceptanceActId(project, grounds.assessment), 1);
  const machine = store.get<FinalMachineAdmission>(finalMachineAdmissionId(project, grounds.assessment), 1);
  if (act?.kind === FINAL_ACCEPTANCE_ACT_KIND) {
    const proven = proveFinalAcceptanceAct(store, project, reference(act), grounds);
    if (proven.value.scope.decision === 'decline') return { accepted: null, acceptance: { state: 'declined', assessment: exact(grounds.assessment),
      act: reference(proven), reason: proven.value.scope.reason } };
    const manifest = acceptanceWrites(project, grounds, { kind: 'owner', act: proven.value }).manifest;
    const basis = await readAcceptedDiscoveryBasisAt(store, project, { id: manifest.id, revision: 1, hash: hashJson(manifest.value as never) });
    return { accepted: basis.accepted, acceptance: acceptedState(basis.accepted) };
  }
  if (machine?.kind === FINAL_MACHINE_ADMISSION_KIND) {
    const proven = proveFinalMachineAdmission(store, project, reference(machine), grounds);
    const manifest = acceptanceWrites(project, grounds, { kind: 'machine', admission: proven.value }).manifest;
    const basis = await readAcceptedDiscoveryBasisAt(store, project, { id: manifest.id, revision: 1, hash: hashJson(manifest.value as never) });
    return { accepted: basis.accepted, acceptance: acceptedState(basis.accepted) };
  }
  return { accepted: null, acceptance: { state: 'awaiting_decision', assessment: exact(grounds.assessment) } };
}
function acceptedState(accepted: AcceptedDiscovery): FinalSummaryAcceptance {
  return { state: 'accepted', assessment: exact(accepted.manifest.value.assessment), manifest: reference(accepted.manifest),
    previous: accepted.manifest.value.previous ? exact(accepted.manifest.value.previous) : null,
    admission: { kind: accepted.admission.kind, record: reference(accepted.admission.record) },
    reason: accepted.admission.kind === 'owner' ? accepted.admission.record.value.scope.reason : null,
    resolutions: accepted.resolutions.map(reference) };
}

/** The summary of one exact saved D7 outcome. A manifest is read as exactly that historical edition; an assessment
 * states its verdict and the decision saved on it; a paid result alone states only its own outcome, unassessed. */
export async function readDiscoveryFinalSummaryAt(store: Store, project: string, request: unknown): Promise<DiscoveryFinalSummary> {
  if (typeof project !== 'string' || !project) invalid('A final summary needs its project');
  const { kind, ref } = decodeDiscoveryFinalSummaryRequest(request);
  let source: DiscoveryFinalAssessmentSource, assessment: FinalSummaryAssessment | null = null;
  let acceptance: FinalSummaryAcceptance = { state: 'unassessed' }, accepted: AcceptedDiscovery | null = null;
  if (kind === 'manifest') {
    const basis = await readAcceptedDiscoveryBasisAt(store, project, ref);
    accepted = basis.accepted; source = accepted.grounds.source;
    assessment = assessmentOf(accepted.grounds.assessment, basis.review);
    acceptance = acceptedState(accepted);
  } else if (kind === 'assessment') {
    const proven = await readDiscoveryFinalAssessmentPaidResultAt(store, project, ref);
    if (!proven.output || !proven.result)
      throw new EngineError('discovery_final_summary_unavailable', 'The assessment has no paid result yet', { assessment: ref });
    source = proven.source; assessment = assessmentOf(reference(proven.output), proven.result.result);
    if (proven.result.verdict === 'return') acceptance = { state: 'returned', assessment: reference(proven.output) };
    else ({ acceptance, accepted } = await acceptanceOf(store, project, reference(proven.output)));
  } else source = await readDiscoveryFinalAssessmentSourceAt(store, project, ref);
  const paid = reference(source.paid), bundle = source.bundle, route = source.packet.final.dossier.route;
  const resolutions = new Map<string, FinalSummaryResolution>();
  for (const row of accepted?.resolutions ?? []) resolutions.set(row.value.conditionId, await resolutionOf(store, project, row));
  const conditions: FinalSummaryCondition[] = bundle.verdict.conditions.map((item, index) => {
    const condition = item as Record<string, unknown>, id = condition.id as string;
    return { id, kind: condition.kind as string, address: located(paid, `/verdict/conditions/${index}`, null).address,
      condition: structuredClone(item), status: !accepted ? 'pending' : accepted.conditions.resolved.includes(id) ? 'resolved' : 'open',
      resolution: resolutions.get(id) ?? null };
  });
  const positive = bundle.verdict.outcome === 'go' || bundle.verdict.outcome === 'conditional';
  const open = conditions.filter(condition => condition.status === 'open');
  let next: FinalSummaryNext | null = null;
  if (acceptance.state === 'returned' && assessment?.return)
    next = { action: 'return', reason: assessment.return.reason, targets: structuredClone(assessment.return.targets) };
  else if (acceptance.state === 'awaiting_decision') next = { action: 'owner_decision', assessment: exact(acceptance.assessment) };
  else if (acceptance.state === 'accepted' && positive)
    next = open.length ? { action: 'resolve_conditions', manifest: exact(acceptance.manifest),
      open: open.map(condition => ({ conditionId: condition.id, address: structuredClone(condition.address) })) }
      : { action: 'consume_accepted', manifest: exact(acceptance.manifest) };
  return {
    contract: DISCOVERY_FINAL_SUMMARY, project, basis: { kind, record: ref }, paid, form: bundle.contract, outcome: bundle.verdict.outcome,
    reason: located(paid, '/verdict/reason', bundle.verdict.reason), summary: located(paid, '/summary', bundle.summary),
    projection: bundle.projection ? located(paid, '/projection', bundle.projection as unknown as Json) : null,
    constitution: bundle.constitution ? located(paid, '/constitution', bundle.constitution as unknown as Json) : null,
    selectedVariant: route.member ? { member: routeValue(route.member)!, set: route.set ? exact(route.set.ref) : null,
      decision: routeValue(route.decision) } : null,
    material: material(paid, bundle), conditions, assessment, acceptance, next,
    permitsNextStage: acceptance.state === 'accepted' && positive && open.length === 0,
  };
}

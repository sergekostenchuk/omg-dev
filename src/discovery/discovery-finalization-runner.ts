import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Environments } from '../runtime/environment.js';
import type { Revision, Store } from '../storage/store.js';
import { acceptDiscoveryFinal } from '../product/owner-authority.js';
import { readRunnerDossierAssessmentAt } from './dossier-assessment-runner.js';
import { prepareDiscoveryFinalSubject } from './discovery-final.js';
import { prepareDiscoveryFinalSession, readDiscoveryFinalSessionAt } from './discovery-final-session.js';
import { discoveryFinalExecutionId, runDiscoveryFinalExecution } from './discovery-final-execution.js';
import { readDiscoveryFinalAssessmentSourceAt } from './discovery-final-assessment-source.js';
import { prepareDiscoveryFinalAssessmentSession, readDiscoveryFinalAssessmentSessionAt } from './discovery-final-assessment-session.js';
import { discoveryFinalAssessmentExecutionId, readDiscoveryFinalAssessmentPaidResultAt,
  runDiscoveryFinalAssessmentExecution } from './discovery-final-assessment-execution.js';
import { finalAcceptanceActId, finalMachineAdmissionId, proveFinalAcceptanceAct, provenAcceptanceGrounds,
  provenAcceptanceMode, readAcceptedDiscoveryManifestAt, readManifestSuccessor } from './discovery-acceptance.js';
import { readResearchReturnAt, researchReturnMaterial } from './discovery-research-return.js';
import { readerPilot } from './reader-pilot.js';
import { researchResultEnvelopeLimit } from './early-research-outcome.js';
import { requireInvocationAllowance, withChildInvocationAllowance } from './invocation-progress.js';
import { V9_FINAL_CONTRACT } from './v7-final-contracts.js';

export const DISCOVERY_FINALIZATION = 'discovery-finalization/v1' as const;
export const DISCOVERY_FINALIZATION_KIND = 'discovery-finalization' as const;
export interface DiscoveryFinalization {
  contract: typeof DISCOVERY_FINALIZATION; projectId: string; origin: Ref; return: Ref | null;
  prepared: Ref; final: Ref | null; assessmentPrepared: Ref | null; assessment: Ref | null;
  accepted: Ref | null; declined: Ref | null;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_finalization_invalid', message);
}
const finalPrompt = 'Produce the whole Discovery bundle in discovery-final/v9 from the complete proven dossier and original assignment. '
  + 'Follow the delivered schema exactly. Preserve every inventory item, unknown, contradiction and partial reason. '
  + 'Choose go, conditional, no_go or insufficient_evidence on the evidence; a supported D6 is not a go decision. '
  + 'For a positive outcome provide the complete structural projection, summary and constitution. Explain each condition and its class. '
  + 'For a negative outcome keep the lawful null projection and constitution. Never announce acceptance.';
const assessmentPrompt = 'Independently assess the complete exact paid discovery-final/v9 bundle against the full dossier and original assignment. '
  + 'Check its outcome, summary, all structural projection fields, constitution, unresolved matters and conditions, including each owner condition class. '
  + 'Return supported only when the complete bundle is justified; otherwise return addressed targets and reasons for correction. '
  + 'Keep a negative candidate negative. A supported assessment is not acceptance.';
const idFor = (project: string, d6: Ref, returned: Ref | null) =>
  `discovery-finalization:${hashJson([DISCOVERY_FINALIZATION, project, d6, returned])}`;
function capturedRef(raw: unknown): Ref {
  let at: unknown;
  try { at = JSON.parse(canonical(raw)); } catch { /* Typed refusal below. */ }
  valid(isRef(at) && object(at) && Object.keys(at).sort().join(',') === 'hash,id,revision', 'An exact finalization reference is required');
  return at;
}
function exact(store: Store, project: string, raw: unknown) {
  const at = capturedRef(raw), row = store.get<DiscoveryFinalization>(at.id, at.revision);
  valid(row?.kind === DISCOVERY_FINALIZATION_KIND && object(row.value) && same(reference(row), at)
    && hashJson(row.value as never) === row.hash, 'The saved finalization is missing or changed');
  const value = row.value;
  valid(same(Object.keys(value).sort(), ['contract','projectId','origin','return','prepared','final','assessmentPrepared','assessment','accepted','declined'].sort())
    && value.contract === DISCOVERY_FINALIZATION && value.projectId === project && isRef(value.origin) && isRef(value.prepared)
    && ['return','final','assessmentPrepared','assessment','accepted','declined'].every(key => value[key as keyof DiscoveryFinalization] === null
      || isRef(value[key as keyof DiscoveryFinalization])), 'The saved finalization has an incomplete form');
  return row;
}
async function returnedInput(store: Store, project: string, returned: Ref | null,
  d6: Awaited<ReturnType<typeof readRunnerDossierAssessmentAt>>) {
  if (!returned) return null;
  const result = await readResearchReturnAt(store, project, returned);
  valid(result.destination === 'D7' && result.final !== null, 'A new final needs a proven addressed D7 return');
  const previous = await readDiscoveryFinalAssessmentSourceAt(store, project, result.final);
  valid(same(previous.paid.value.subject.basis.assessment, d6.result.assessment)
    && previous.packet.final.subject.basis.draft.id === d6.run.value.draftId,
  'The D7 return belongs to another paid dossier or run');
  return result;
}
function promptFor(returned: Awaited<ReturnType<typeof returnedInput>>) {
  return finalPrompt + (returned ? '\nCorrect this independently proven addressed return, preserving the previous complete final and its grounds:\n'
    + canonical({ return: reference(returned.record), material: researchReturnMaterial(returned) }) : '');
}
/** Exact historical output, including paid material and admission; current mode and heads are not evidence. */
export async function readDiscoveryFinalizationAt(store: Store, project: string, at: unknown) {
  const record = exact(store, project, at), value = record.value;
  const dossier = await readRunnerDossierAssessmentAt(store, project, value.origin);
  valid(dossier.result.verdict === 'supported' && record.id === idFor(project, dossier.result.assessment, value.return),
    'Only a supported exact D6 may enter this finalization');
  const returned = await returnedInput(store, project, value.return, dossier);
  const prepared = await readDiscoveryFinalSessionAt(store, project, value.prepared);
  valid(same(prepared.value.subject.basis.assessment, dossier.result.assessment)
    && prepared.value.input.form === V9_FINAL_CONTRACT && prepared.value.input.prompt === promptFor(returned),
  'The final preparation substitutes another dossier, version or return');
  const final = value.final ? await readDiscoveryFinalAssessmentSourceAt(store, project, value.final) : null;
  valid(!final || same(reference(final.prepared), value.prepared) && final.bundle.contract === V9_FINAL_CONTRACT,
    'The paid final differs from its prepared subject');
  const assessmentPrepared = value.assessmentPrepared
    ? await readDiscoveryFinalAssessmentSessionAt(store, project, value.assessmentPrepared) : null;
  valid(!assessmentPrepared || final && same(assessmentPrepared.value.subject, final.packet.subject)
    && assessmentPrepared.value.input.prompt === assessmentPrompt, 'The assessment preparation substitutes another complete final');
  const assessment = value.assessment ? await readDiscoveryFinalAssessmentPaidResultAt(store, project, value.assessment) : null;
  valid(!assessment || final && assessmentPrepared && same(reference(assessment.source.paid), value.final)
    && same(reference(assessment.prepared), value.assessmentPrepared), 'The paid assessment is not this exact final');
  const accepted = value.accepted ? await readAcceptedDiscoveryManifestAt(store, project, value.accepted) : null;
  valid(!accepted || assessment?.result?.verdict === 'supported' && same(accepted.grounds.assessment, value.assessment)
    && same(accepted.grounds.paid, value.final), 'Acceptance does not prove this paid final and assessment');
  const declined = value.declined ? proveFinalAcceptanceAct(store, project, value.declined,
    await provenAcceptanceGrounds(store, project, value.assessment!)) : null;
  valid(!declined || assessment?.result?.verdict === 'supported' && declined.value.scope.decision === 'decline'
    && !accepted, 'The saved declining act is not this final decision');
  const status = accepted ? 'accepted' as const : declined ? 'declined' as const
    : assessment?.result?.verdict === 'return' ? 'returned' as const : assessment ? 'needs_owner' as const
    : final ? 'assessing' as const : 'producing' as const;
  return { record, dossier, returned, prepared, final, assessmentPrepared, assessment, accepted, declined, status,
    outcome: final?.bundle.verdict.outcome ?? null,
    correction: assessment?.result?.result.return ?? null,
    view: { record: reference(record), status, final: value.final, assessment: value.assessment, manifest: value.accepted,
      outcome: final?.bundle.verdict.outcome ?? null, conditions: accepted?.conditions ?? null,
      correction: assessment?.result?.result.return ?? null,
      next: status === 'producing' ? 'discovery-final' as const : status === 'assessing' ? 'final-assessment' as const
        : status === 'needs_owner' ? 'owner-final-acceptance' as const : status === 'returned' || status === 'declined' ? 'revise-final' as const
        : accepted?.conditions.open.length ? 'conditions' as const
        : final?.bundle.verdict.outcome === 'go' || final?.bundle.verdict.outcome === 'conditional' ? 'concept' as const : null } };

}
/** Persist a late step without trusting caller status; all refs are re-proven at the public read door. */
function save(store: Store, row: Revision<DiscoveryFinalization>, change: Partial<DiscoveryFinalization>) {
  const value = { ...row.value, ...change };
  if (same(row.value, value)) return row;
  return store.writeMany<DiscoveryFinalization>([{ id: row.id, kind: row.kind, expected: row.revision, value }], [reference(row)])[0]!;
}
function preparationInput(store: Store, project: string, prompt: string, assessor: boolean) {
  const environment = new Environments(store).effective(project).environment, profile = readerPilot(store, project);
  const limitChars = researchResultEnvelopeLimit(environment.value, profile?.value);
  // Reserve physical instruction/envelope space within the configured limit; never increase the admission.
  const packetChars = limitChars - prompt.length - 8192;
  requireCondition(packetChars > 0, 'research_capacity_configuration', 'The final instruction does not fit the configured envelope');
  return { input: { prompt, packetChars, limitChars, resultLimitChars: limitChars,
    environment: reference(environment), role: assessor ? environment.value.reviewer : environment.value.implementer }, profile };
}
export interface RunDiscoveryFinalizationOptions { allowance: number; restoreOnly: boolean; signal?: AbortSignal | undefined; researchReturn?: Ref | null }
/** The caller's shared physical allowance also covers every nested producer page. No local counter is reset here. */
export async function runDiscoveryFinalization(store: Store, project: string, originRef: Ref, options: RunDiscoveryFinalizationOptions) {
  valid(object(options), 'Finalization needs explicit execution options');
  const { allowance, restoreOnly, signal, researchReturn: rawReturn } = options;
  const returnedRef = rawReturn == null ? null : capturedRef(rawReturn), origin = capturedRef(originRef);
  valid(Number.isSafeInteger(allowance) && allowance >= 0 && typeof restoreOnly === 'boolean', 'An explicit bounded invocation is required');
  const work = () => advanceFinalization(store, project, origin, { allowance, restoreOnly, signal, researchReturn: returnedRef });
  return allowance > 0 ? withChildInvocationAllowance(allowance, work) : work();
}
async function advanceFinalization(store: Store, project: string, originRef: Ref, options: RunDiscoveryFinalizationOptions) {
  const { allowance, restoreOnly, signal } = options, returnedRef = options.researchReturn ?? null;
  const dossier = await readRunnerDossierAssessmentAt(store, project, capturedRef(originRef));
  if (dossier.result.verdict !== 'supported') return null;
  const returned = await returnedInput(store, project, returnedRef, dossier);
  const id = idFor(project, dossier.result.assessment, returnedRef);
  let row = store.get<DiscoveryFinalization>(id);
  const maySend = () => {
    if (restoreOnly || allowance === 0) return false;
    try { requireInvocationAllowance(); return true; }
    catch (error) { if (error instanceof EngineError && error.code === 'research_call_allowance') return false; throw error; }
  };
  if (!row) {
    if (!maySend()) return null;
    const packet = await prepareDiscoveryFinalSubject(store, project, dossier.result.assessment);
    const { input } = preparationInput(store, project, promptFor(returned), false);
    const prepared = await prepareDiscoveryFinalSession(store, project, packet.subject, { ...input, form: V9_FINAL_CONTRACT });
    const value: DiscoveryFinalization = { contract: DISCOVERY_FINALIZATION, projectId: project, origin: reference(dossier.run),
      return: returnedRef, prepared: reference(prepared), final: null, assessmentPrepared: null, assessment: null, accepted: null, declined: null };
    row = store.writeMany<DiscoveryFinalization>([{ id, kind: DISCOVERY_FINALIZATION_KIND, expected: 0, value }], [reference(dossier.run)])[0]!;
  }
  let proof = await readDiscoveryFinalizationAt(store, project, reference(row));
  if (!row.value.final) {
    const execution = store.get(discoveryFinalExecutionId(row.value.prepared));
    let result = execution ? await runDiscoveryFinalExecution(store, project, row.value.prepared, { restoreOnly: true, allowance: 0, ...(signal ? { signal } : {}) }) : null;
    if (!result?.output && maySend()) {
      const profile = readerPilot(store, project);
      try { result = await runDiscoveryFinalExecution(store, project, row.value.prepared,
        { allowance, ...(signal ? { signal } : {}), ...(profile ? { profile } : {}) }); }
      catch (error) { if (!(error instanceof EngineError) || error.code !== 'research_call_allowance') throw error; }
    }
    if (!result?.output) return readDiscoveryFinalizationAt(store, project, reference(row));
    row = save(store, row, { final: reference(result.output) });
    proof = await readDiscoveryFinalizationAt(store, project, reference(row));
  }
  if (!row.value.assessmentPrepared) {
    if (!maySend()) return proof;
    const { input } = preparationInput(store, project, assessmentPrompt, true);
    const prepared = await prepareDiscoveryFinalAssessmentSession(store, project, proof.final!.packet.subject, input);
    row = save(store, row, { assessmentPrepared: reference(prepared) });
  }
  if (!row.value.assessment) {
    const execution = store.get(discoveryFinalAssessmentExecutionId(row.value.final!, row.value.assessmentPrepared!));
    let result = execution ? await runDiscoveryFinalAssessmentExecution(store, project, row.value.final!, row.value.assessmentPrepared!,
      { restoreOnly: true, allowance: 0, ...(signal ? { signal } : {}) }) : null;
    if (!result?.output && maySend()) {
      const profile = readerPilot(store, project);
      try { result = await runDiscoveryFinalAssessmentExecution(store, project, row.value.final!, row.value.assessmentPrepared!,
        { allowance, ...(signal ? { signal } : {}), ...(profile ? { profile } : {}) }); }
      catch (error) { if (!(error instanceof EngineError) || error.code !== 'research_call_allowance') throw error; }
    }
    if (!result?.output) return readDiscoveryFinalizationAt(store, project, reference(row));
    row = save(store, row, { assessment: reference(result.output) });
  }
  proof = await readDiscoveryFinalizationAt(store, project, reference(row));
  if (proof.status === 'returned' || proof.declined) return proof;
  if (!proof.accepted) {
    const saved = store.get(finalAcceptanceActId(project, row.value.assessment!))
      ?? store.get(finalMachineAdmissionId(project, row.value.assessment!));
    // Questions mode never mints owner authority. Replay only an already proven act.
    if (saved || !restoreOnly && provenAcceptanceMode(store, project).mode === 'bypass') {
      const accepted = await acceptDiscoveryFinal(store, { projectId: project, assessment: row.value.assessment,
        decision: 'accept', reason: 'Admit the independently assessed complete Discovery bundle under the saved project mode' });
      row = save(store, row, { accepted: accepted.accepted ? reference(accepted.accepted.manifest) : null,
        declined: accepted.decision === 'decline' && accepted.act ? reference(accepted.act) : null });
      proof = await readDiscoveryFinalizationAt(store, project, reference(row));
    }
  }
  // A lawful condition edition remains tied to the same paid bundle and assessment.
  while (proof.accepted) {
    const next = readManifestSuccessor(store, project, reference(proof.accepted.manifest));
    if (!next) break;
    const accepted = await readAcceptedDiscoveryManifestAt(store, project, next.value.successor);
    valid(same(accepted.grounds.assessment, row.value.assessment), 'A condition edition changed the paid assessment');
    row = save(store, row, { accepted: reference(accepted.manifest) });
    proof = await readDiscoveryFinalizationAt(store, project, reference(row));
  }
  return proof;
}

/** A run's late pointer is only an address: independently prove the D6 and the complete saved finalization. */
export async function readRunnerFinalizationAt(store: Store, project: string, at: Ref) {
  const dossier = await readRunnerDossierAssessmentAt(store, project, capturedRef(at));
  valid(isRef(dossier.run.value.finalization), 'The run has no exact finalization');
  const proof = await readDiscoveryFinalizationAt(store, project, dossier.run.value.finalization);
  valid(proof.dossier.run.id === dossier.run.id && same(proof.dossier.result, dossier.result),
    'The saved finalization belongs to another run or paid dossier');
  return { ...proof, run: dossier.run };
}
/** A paid addressed D7 return is a successor of exactly this prior final, never a caller-supplied destination. */
export async function nextRunnerFinalReturn(store: Store, project: string,
  prior: Awaited<ReturnType<typeof readRunnerFinalizationAt>>) {
  if (!prior.final) return prior.record.value.return;
  for (const row of store.list<Record<string, unknown>>('discovery-research-return')) {
    const requestRef = row.value?.request;
    if (!isRef(requestRef)) continue;
    const request = store.get<{ input?: { final?: unknown; destination?: unknown } }>(requestRef.id, requestRef.revision);
    if (!same(request?.value?.input?.final ?? null, reference(prior.final.paid)) || request?.value?.input?.destination !== 'D7') continue;
    const result = await readResearchReturnAt(store, project, reference(row));
    if (result.destination === 'D7') return reference(result.record);
  }
  return prior.record.value.return;
}

export type DiscoveryFinalizationView = Awaited<ReturnType<typeof readDiscoveryFinalizationAt>>['view'];

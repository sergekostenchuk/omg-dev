import { canonical, hashJson, type Json } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard } from '../storage/store.js';
import { prepareDossierAssessmentSubject } from './dossier-assessment.js';
import { readPartialDossier } from './dossier-manifest.js';
import { readVariantHandoff } from './discovery-outcome.js';
import { assessDossier, publishDossierAssessment, readDossierAssessmentAt } from './research-assessment.js';
import { DOSSIER_SESSION, runDossierAssessmentSession, type DossierAssessmentSession } from './assessment-session.js';
import { Environments } from '../runtime/environment.js';
import { readerPilot } from './reader-pilot.js';
import { readEffectiveStageBudget, DISCOVERY_V7_STAGE_BUDGET_KEY } from './stage-token-budget.js';
import { budgetUsage, workingLimit } from '../runtime/research-budget.js';
import { currentPlan } from './v7-plan-questions.js';
import { executionAdmission } from './projection-reader.js';
import { readCurrentVariantScope } from './variant-scope.js';
import { readVariantStateStructural, variantStateId, type VariantState } from './variant-decision.js';
import type { DossierAssessmentPacket, ResearchRun, ResearchRunDossierAssessment } from './research-model.js';

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'research_dossier_result_invalid', message);
}
function exactRun(store: Store, project: string, at: unknown): Revision<ResearchRun> {
  let captured: unknown;
  try { captured = JSON.parse(canonical(at)); } catch { /* Typed refusal below. */ }
  invalid(isRef(captured), 'The dossier continuation needs an exact run');
  const row = store.get<ResearchRun>(captured.id, captured.revision);
  invalid(row?.kind === 'research-run' && record(row.value) && same(reference(row), captured) && hashJson(row.value as unknown as Json) === row.hash
    && row.value.projectId === project && typeof row.value.draftId === 'string' && row.value.draftId.length > 0 && row.id === `research-run:${hashJson([project, row.value.draftId])}`,
  'The dossier continuation lost its exact original run');
  return row;
}
/** Current witnesses are used only for another physical send, never historical recovery. */
function currentRunnerDossier(store: Store, project: string, origin: Revision<ResearchRun>, packet: DossierAssessmentPacket): TransactionGuard[] {
  const current = currentPlan(store, project);
  invalid(current.draft.id === origin.value.draftId && same(current.planAnswer, packet.basis.plan.ref)
    && executionAdmission(store, current.draft, 'new-research', { discovery: 7 }).admitted,
  'A new dossier assessment requires its still-current admitted plan');
  const guards: TransactionGuard[] = [reference(origin), reference(current.draft), reference(current.question), current.planAnswer];
  const stateId = variantStateId(project, origin.value.draftId), state = store.get<VariantState>(stateId);
  if (packet.route.scope) {
    const scope = readCurrentVariantScope(store, project, packet.basis.draft.ref);
    invalid(same(reference(scope.scope), packet.route.scope.ref), 'The current choice no longer names this dossier scope');
    guards.push(reference(scope.state), reference(scope.scope));
  } else if (packet.route.result) {
    invalid(state, 'The partial route lost its current generation');
    readVariantStateStructural(store, project, origin.value.draftId, reference(state));
    invalid(same(state.value.result, packet.route.result.ref) && same(state.value.decision, packet.route.decision?.ref ?? null),
      'The current negative choice no longer names this partial dossier');
    guards.push(reference(state));
  } else {
    invalid(!state, 'A new generation replaced this early-limit dossier');
    guards.push({ id: stateId, absent: true });
  }
  return guards;
}
/** The old pause is an address carrier, never evidence supplied by its error text. */
export async function readRunnerDossierInput(store: Store, project: string, at: Ref) {
  const origin = exactRun(store, project, at);
  invalid(origin.value.status === 'paused', 'Dossier assessment must start at a saved pause');
  let saved: any;
  try { saved = JSON.parse(origin.value.error ?? 'null'); } catch { /* Typed refusal below. */ }
  let root: Ref;
  if (origin.value.pauseCode === 'research_selected_dossier_assessment_unavailable') {
    const { readSelectedResearchPause } = await import('./research-runner.js');
    const proven = await readSelectedResearchPause(store, project, origin.value.draftId, origin);
    invalid(proven.selected, 'The selected pause needs its complete published dossier');
    root = reference(proven.selected.record);
  } else {
    invalid(origin.value.pauseCode === 'research_dossier_assessment_unavailable' && isRef(saved?.handoff)
      && isRef(saved?.dossier) && !Object.hasOwn(saved, 'selected'), 'The partial pause lost its exact route');
    const dossier = await readPartialDossier(store, project, saved.dossier);
    const handoff = (await readVariantHandoff(store, project, saved.handoff)).record;
    invalid(same(reference(dossier.handoff), reference(handoff)) && handoff.value.draft.id === origin.value.draftId
      && same(dossier.record.value.draft, handoff.value.draft)
      && (dossier.stop ? isRef(saved.stop) && same(reference(dossier.stop), saved.stop) : !Object.hasOwn(saved, 'stop')),
    'The partial dossier differs from its saved run and stop');
    root = reference(dossier.record);
  }
  const packet = await prepareDossierAssessmentSubject(store, project, root);
  invalid(packet.basis.draft.ref.id === origin.value.draftId, 'The dossier names another draft');
  return { origin, packet };
}
/** Historical result door: no caller verdict or current head substitutes for the paid reader. */
export async function readRunnerDossierAssessmentAt(store: Store, project: string, at: unknown) {
  const run = exactRun(store, project, at), saved = run.value.dossierAssessment;
  invalid(saved?.contract === 'research-run-dossier-assessment/v1' && isRef(saved.origin) && isRef(saved.assessment),
    'The run has no exact paid dossier result');
  const input = await readRunnerDossierInput(store, project, saved.origin);
  invalid(input.origin.id === run.id && input.origin.revision < run.revision, 'The result belongs to another run origin');
  const assessment = await readDossierAssessmentAt(store, project, saved.assessment);
  const result: ResearchRunDossierAssessment = {
    contract: 'research-run-dossier-assessment/v1', origin: reference(input.origin), root: input.packet.subject.root.ref,
    manifest: input.packet.subject.manifest, assessment: reference(assessment), verdict: assessment.value.result.result.verdict,
    return: assessment.value.result.result.return,
  };
  invalid(same(assessment.value.subject, input.packet.subject) && same(saved, result),
    'The saved continuation differs from its exact paid dossier');
  invalid(run.value.status === 'paused' && run.value.pauseCode ===
    (result.verdict === 'supported' ? 'research_dossier_ready' : 'research_dossier_return'),
  'A paid D6 result cannot mark Discovery completed or accepted');
  return { run, ...input, assessment, result };
}
/** Settle paid pages before obtaining today's runtime. Every new physical page shares the runner allowance. */
export async function runRunnerDossierAssessment(store: Store, project: string, at: Ref,
  options: { allowance: number; restoreOnly: boolean; signal?: AbortSignal }) {
  invalid(options && typeof options === 'object' && !Array.isArray(options),
    'Dossier execution needs explicit options');
  const {allowance,restoreOnly,signal} = options;
  invalid(Number.isSafeInteger(allowance) && allowance >= 0 && typeof restoreOnly === 'boolean',
    'Dossier execution needs an explicit bounded allowance and restore mode');
  const input = await readRunnerDossierInput(store, project, at), subject = input.packet.subject;
  const sessions = store.list<DossierAssessmentSession>('assessment-session').filter(row => {
    invalid(record(row.value), `Saved assessment session ${row.id} must be a record`);
    return row.value.contract === DOSSIER_SESSION && same(row.value.subject, subject);
  });
  invalid(sessions.length <= 1, 'Several dossier sessions claim the same exact subject');
  let assessment;
  if (sessions.length) {
    const restored = await runDossierAssessmentSession(store, project, subject, undefined, undefined, signal, { restoreOnly: true });
    if (restored.result) assessment = await publishDossierAssessment(store, project, reference(restored.session));
  }
  if (!assessment) {
    if (restoreOnly || allowance === 0) return null;
    // Completion may spend the research reserve, but cannot overdraw the stage
    // or its working group. Keep an exhausted old pause inert before creating
    // any new session; the ordinary forecast still admits each physical send.
    const budget = readEffectiveStageBudget(store, project);
    if (!sessions.length && budget.segment) {
      const usage = budgetUsage(store, budget.segment), group = usage.groups[DISCOVERY_V7_STAGE_BUDGET_KEY];
      if (usage.measured + usage.reserved >= budget.limit || (group?.measured ?? 0) + (group?.reserved ?? 0)
        >= workingLimit(store, budget.segment, DISCOVERY_V7_STAGE_BUDGET_KEY, 'tokens', budget.segment.value.initialGroupLimit)) return null;
    }
    const admissionGuards = currentRunnerDossier(store, project, input.origin, input.packet);
    const environment = new Environments(store).effective(project).environment;
    assessment = await assessDossier(store, project, subject, environment, readerPilot(store, project) ?? undefined,
      signal, { allowance, admissionGuards });
  }
  const result: ResearchRunDossierAssessment = { contract: 'research-run-dossier-assessment/v1', origin: reference(input.origin),
    root: subject.root.ref, manifest: subject.manifest, assessment: reference(assessment),
    verdict: assessment.value.result.result.verdict, return: assessment.value.result.result.return };
  return { ...input, assessment, result };
}

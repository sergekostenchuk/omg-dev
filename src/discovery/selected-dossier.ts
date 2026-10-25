import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { uniqueTransactionGuards, transactionGuardsCurrent } from '../runtime/environment.js';
import { readProjectMode } from '../product/project-mode.js';
import { computeMissingCoverageAt, type CoverageComputation } from './coverage.js';
import { DOSSIER_MANIFEST_KIND, DOSSIER_MANIFEST_CONTRACT, decodeDossierManifest, dossierManifestId,
  readDossierManifestStructural, projectDossierMaterials, proveDossierFrame, type DossierManifest } from './dossier-manifest.js';
import { checkDossierContradictionEvidence, type ProvenDossierContradiction } from './dossier-contradictions.js';
import { readVariantScope, readCurrentVariantScope } from './variant-scope.js';
import { readVariantSnapshot } from './variant-snapshot.js';
import { currentPlan, provePlanQuestions, type V7Attempt } from './v7-plan-questions.js';
import { V7_ATTEMPT_KIND } from './v7-contracts.js';
import { DISCOVERY_ASSESSMENT_KIND, attemptAccountKey, v7ProgressStateId } from './v7-attempt-assessment.js';
import { readV7ProgressStateAt } from './v7-progress.js';
import type { DiscoveryDraft, Question } from './discovery.js';
import type { PaidDiscoveryAttemptsAssessment, ResearchAnswer, V7ProgressApplication, V7AttemptAccount } from './research-model.js';

export const SELECTED_DOSSIER_KIND = 'discovery-selected-dossier' as const;
export const SELECTED_DOSSIER_CONTRACT = 'discovery-selected-dossier/v1' as const;
export interface SelectedDossierInventory {
  attempts: Ref[]; assessments: Ref[]; applications: Ref[]; states: Ref[]; accounts: Ref[];
}
/** The manifest keeps its v1 form. This separate carrier fixes the exact selected
 * subject and full inventory on which completeness is proved, never an accepted flag. */
export interface SelectedDossier {
  contract: typeof SELECTED_DOSSIER_CONTRACT; projectId: string;
  draft: Ref; frame: Ref; plan: Ref; scope: Ref; set: Ref; member: Ref; decision: Ref; manifest: Ref;
  boundary: { sequence: number; record: Ref }; inventory: SelectedDossierInventory;
}
export interface ProvenSelectedDossier {
  verification: 'complete'; record: Revision<SelectedDossier>; manifest: Revision<DossierManifest>;
  coverage: CoverageComputation; materials: ReturnType<typeof projectDossierMaterials>['materials'];
  contradictions: ProvenDossierContradiction[];
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function invalid(field: string, message: string): never {
  throw new EngineError('discovery_selected_dossier_invalid', `[${field}] ${message}`, { field });
}
function stale(field: string): never {
  throw new EngineError('discovery_selected_dossier_stale', 'The selected dossier changed before publication', { field });
}
function object(value: unknown, keys: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !same(Object.keys(value).sort(), [...keys].sort())) invalid(field, 'The closed form has missing or extra fields');
}
function exactRef(value: unknown, field: string): asserts value is Ref {
  object(value, ['id', 'revision', 'hash'], field);
  if (!isRef(value) || !/^[a-f0-9]{64}$/.test(value.hash)) invalid(field, 'An exact non-null Ref is required');
}
const inventoryKeys = ['attempts', 'assessments', 'applications', 'states', 'accounts'] as const;
const links = ['draft', 'frame', 'plan', 'scope', 'set', 'member', 'decision', 'manifest'] as const;
export function decodeSelectedDossier(value: unknown): SelectedDossier {
  object(value, ['contract', 'projectId', ...links, 'boundary', 'inventory'], 'record');
  if (value.contract !== SELECTED_DOSSIER_CONTRACT || typeof value.projectId !== 'string' || !value.projectId)
    invalid('contract', 'A selected dossier names its known version and project');
  for (const key of links) exactRef(value[key], key);
  object(value.boundary, ['sequence', 'record'], 'boundary');
  if (!Number.isSafeInteger(value.boundary.sequence) || Number(value.boundary.sequence) <= 0) invalid('boundary', 'A committed cut is required');
  exactRef(value.boundary.record, 'boundary.record');
  object(value.inventory, inventoryKeys, 'inventory');
  for (const key of inventoryKeys) {
    const rows = value.inventory[key];
    if (!Array.isArray(rows)) invalid(`inventory.${key}`, 'An exact inventory is required');
    rows.forEach((row, i) => exactRef(row, `inventory.${key}.${i}`));
    if (!same(rows, sorted(rows))) invalid(`inventory.${key}`, 'Inventory is unique and canonically ordered');
  }
  return structuredClone(value) as unknown as SelectedDossier;
}
function sorted(rows: Ref[]): Ref[] {
  return [...new Map(rows.map(row => [canonical(row), row])).values()].sort((a,b) => canonical(a).localeCompare(canonical(b)));
}
/** Service events do not create another copy of the same exact material bundle. */
export function selectedDossierId(value: SelectedDossier): string {
  const { boundary: _cut, ...bundle } = value;
  return `${SELECTED_DOSSIER_KIND}:${value.projectId}:${hashJson(bundle as never)}`;
}
function exact<T>(store: Store, at: Ref, kind?: string): Revision<T> {
  exactRef(at, 'grounds');
  const row = store.get<T>(at.id, at.revision);
  if (!row || kind && row.kind !== kind || !same(reference(row), at) || hashJson(row.value as never) !== at.hash)
    invalid('grounds', 'An exact saved ground is absent, foreign or damaged');
  return row;
}
function atCut<T>(store: Store, boundary: number, at: Ref): Revision<T> {
  const row = exact<T>(store, at);
  const cut = store.getAtEvent(boundary, at.id, at.revision);
  if (!cut || !same(reference(cut), at)) invalid('boundary', 'An exact ground lies beyond the saved cut');
  return row;
}
/** Inventory selection is shared by producer/reader; every candidate is proved by
 * the MR/P/material doors below. A journal event itself never proves coverage. */
function inventory(store: Store, project: string, plan: Ref, draft: Revision<DiscoveryDraft>, boundary: number): SelectedDossierInventory {
  const attempts = store.identitiesAtEvent(boundary, V7_ATTEMPT_KIND).map(r => atCut<V7Attempt>(store, boundary, { id: r.id, revision: r.revision, hash: r.hash }))
    .filter(r => r.value.project === project && same(r.value.planAnswer, plan));
  const assessments = store.identitiesAtEvent(boundary, DISCOVERY_ASSESSMENT_KIND)
    .map(r => atCut<PaidDiscoveryAttemptsAssessment>(store, boundary, { id: r.id, revision: r.revision, hash: r.hash }))
    .filter(r => r.value.projectId === project && same(r.value.subject?.packet?.planAnswer, plan));
  const states: Ref[] = [], applications: Ref[] = [], accounts: Ref[] = [];
  for (const question of provePlanQuestions(store, draft, plan)) {
    const id = v7ProgressStateId({ project, planAnswer: plan, planQuestionId: question.planQuestionId });
    const head = store.getAtEvent<{ application: Ref }>(boundary, id);
    if (!head) continue;
    readV7ProgressStateAt(store, reference(head)); states.push(reference(head));
    let cursor: Ref | null = reference(head);
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(canonical(cursor))) invalid('applications', 'A progress chain is cyclic');
      visited.add(canonical(cursor));
      const state = atCut<{ application: Ref }>(store, boundary, cursor);
      const application: Revision<V7ProgressApplication> = atCut(store, boundary, state.value.application);
      applications.push(reference(application));
      cursor = application.value.previous;
    }
  }
  for (const row of attempts) {
    const account = store.getAtEvent<V7AttemptAccount>(boundary, attemptAccountKey(row.value, reference(row)), 1);
    if (account) { accounts.push(reference(account)); atCut(store, boundary, account.value.application); }
  }
  return { attempts: sorted(attempts.map(reference)), assessments: sorted(assessments.map(reference)),
    states: sorted(states), applications: sorted(applications), accounts: sorted(accounts) };
}
function projection(store: Store, project: string, scope: Ref, plan: Ref, boundary: SelectedDossier['boundary']) {
  if (!(store instanceof Store) || typeof project !== 'string' || !project) invalid('store', 'A Store and project are required');
  exactRef(scope, 'scope'); exactRef(plan, 'plan');
  if (!same(store.eventAt(boundary.sequence), boundary.record)) invalid('boundary', 'The saved journal cut is absent or changed');
  const selected = readVariantScope(store, project, scope), subject = selected.scope.value;
  atCut(store, boundary.sequence, scope);
  const draft = atCut<DiscoveryDraft>(store, boundary.sequence, subject.draft);
  const source = selected.generation.session.value.variantSubject;
  if (source.kind !== 'proposal') invalid('scope', 'The chosen scope requires its paid generation');
  const snapshot = readVariantSnapshot(store, project, source.snapshot);
  if (!same(snapshot.value.plan, plan)) invalid('plan', 'The selected generation and dossier name one exact plan');
  const frameRef = (exact<ResearchAnswer>(store, plan, 'research-answer').value.value as unknown as { frame: Ref }).frame;
  const frame = proveDossierFrame(store, project, draft, frameRef);
  atCut(store, boundary.sequence, frameRef); atCut(store, boundary.sequence, plan);
  const coverage = computeMissingCoverageAt(store, project, scope, plan, boundary.sequence);
  if (!coverage.cells.length || coverage.missing.length)
    throw new EngineError('discovery_selected_dossier_incomplete', 'Every applicable exact variant cell requires applied sufficiency',
      { missing: coverage.missing.map(c => ({ cell: c.cell, missing: c.missing })) });
  const saved = inventory(store, project, plan, draft, boundary.sequence);
  const material = projectDossierMaterials(store, project, draft, frame, plan, saved.attempts, saved.assessments, boundary.sequence);
  const manifest = decodeDossierManifest({ contract: DOSSIER_MANIFEST_CONTRACT, projectId: project,
    draft: subject.draft, frame: frameRef, plan, completeness: 'complete', reasons: [], axes: material.axes,
    unknowns: material.unknowns, contradictions: material.contradictions });
  const contradictions = checkDossierContradictionEvidence(store, manifest,
    provePlanQuestions(store, draft, plan).map(q => q.planQuestionId), { assessments: material.assessments });
  const manifestRef: Ref = { id: dossierManifestId(manifest), revision: 1, hash: hashJson(manifest as never) };
  const value: SelectedDossier = { contract: SELECTED_DOSSIER_CONTRACT, projectId: project,
    draft: subject.draft, frame: frameRef, plan, scope, set: subject.set, member: subject.member,
    decision: subject.decision, manifest: manifestRef, boundary, inventory: saved };
  return { value, manifest, coverage, materials: material.materials, contradictions };
}
/** Historical completeness uses only the saved exact inventory and original cut.
 * It never consults current selection, authority or current P for acceptance. */
export function readSelectedDossier(store: Store, project: string, at: Ref): ProvenSelectedDossier {
  const raw = exact<unknown>(store, at, SELECTED_DOSSIER_KIND), value = decodeSelectedDossier(raw.value);
  if (raw.revision !== 1 || raw.id !== selectedDossierId(value) || value.projectId !== project) invalid('record', 'Noncanonical selected dossier');
  for (const key of links) exact(store, value[key]);
  for (const key of inventoryKeys) for (const link of value.inventory[key]) exact(store, link);
  const proof = projection(store, project, value.scope, value.plan, value.boundary);
  if (!same(proof.value, value)) invalid('inventory', 'The saved bundle is not the full proven inventory at its original cut');
  const manifest = readDossierManifestStructural(store, project, value.manifest).record;
  if (!same(manifest.value, proof.manifest)) invalid('manifest', 'The complete manifest differs from its proven projection');
  return { verification: 'complete', record: { ...raw, value }, manifest, coverage: proof.coverage,
    materials: proof.materials, contradictions: proof.contradictions };
}
function currentGuards(store: Store, project: string, value: SelectedDossier): TransactionGuard[] {
  const plan = currentPlan(store, project), scope = readCurrentVariantScope(store, project, value.draft);
  const mode = readProjectMode(store, project);
  const frame = plan.draft.value.questions.map(id => store.get<Question>(id)).find(q => q?.value.spec.field === 'frame');
  if (!same(reference(plan.draft), value.draft) || !same(plan.planAnswer, value.plan)
    || !frame || frame.value.status !== 'answered' || !same(frame.value.answer, value.frame)
    || !same(reference(scope.scope), value.scope) || !same(mode.ref, scope.scope.value.mode)) stale('admission');
  const guards: TransactionGuard[] = [reference(plan.draft), reference(plan.question), reference(frame), value.frame, value.plan,
    value.scope, value.decision, value.set, value.member, reference(scope.state), mode.ref, ...value.inventory.states];
  if (!transactionGuardsCurrent(store, guards)) stale('guards');
  return uniqueTransactionGuards(guards);
}
/** A new publication derives everything; the only caller subjects are scope/plan.
 * An exact carrier Ref requests historical replay, including after later heads. */
export function produceSelectedDossier(store: Store, project: string, input: unknown): ProvenSelectedDossier & { repeated: boolean } {
  if (isRef(input)) return { ...readSelectedDossier(store, project, input), repeated: true };
  object(input, ['scope', 'plan'], 'input'); exactRef(input.scope, 'scope'); exactRef(input.plan, 'plan');
  const sequence = store.lastEvent(), record = store.eventAt(sequence);
  if (!record) invalid('boundary', 'The selected dossier requires a committed origin');
  const proof = projection(store, project, input.scope, input.plan, { sequence, record });
  const id = selectedDossierId(proof.value), existing = store.get(id, 1);
  if (existing) return { ...readSelectedDossier(store, project, reference(existing)), repeated: true };
  const guards = currentGuards(store, project, proof.value);
  const manifestId = proof.value.manifest.id, savedManifest = store.get(manifestId, 1);
  if (savedManifest) {
    const found = readDossierManifestStructural(store, project, reference(savedManifest)).record;
    if (!same(found.value, proof.manifest)) invalid('manifest', 'An existing manifest differs');
  }
  store.atomicWrite(view => {
    // Under the write lock, no phantom material or application can enter the
    // cut. Re-enumeration also preserves refusal on opaque inventory overlays.
    if (view.lastEvent() !== sequence) stale('boundary');
    for (const [kind, refs] of [[V7_ATTEMPT_KIND, proof.value.inventory.attempts], [DISCOVERY_ASSESSMENT_KIND, proof.value.inventory.assessments]] as const) {
      const rows = view.list<any>(kind).filter(row => kind === V7_ATTEMPT_KIND
        ? row.value.project === project && same(row.value.planAnswer, input.plan)
        : row.value.projectId === project && same(row.value.subject?.packet?.planAnswer, input.plan));
      if (!same(sorted(rows.map(reference)), refs)) stale('inventory');
    }
    const writes: Write[] = [];
    if (!savedManifest) writes.push({ id: manifestId, kind: DOSSIER_MANIFEST_KIND, expected: 0, value: proof.manifest as never });
    writes.push({ id, kind: SELECTED_DOSSIER_KIND, expected: 0, value: proof.value as never });
    return { value: null, writes, guards };
  });
  // The proof just computed is the exact committed bundle; avoid recomputing it.
  return { verification: 'complete', record: exact<SelectedDossier>(store, { id, revision: 1, hash: hashJson(proof.value as never) }, SELECTED_DOSSIER_KIND),
    manifest: exact<DossierManifest>(store, proof.value.manifest, DOSSIER_MANIFEST_KIND),
    coverage: proof.coverage, materials: proof.materials, contradictions: proof.contradictions, repeated: false };
}

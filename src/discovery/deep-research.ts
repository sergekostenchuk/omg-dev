import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard } from '../storage/store.js';
import { transactionGuardsCurrent, uniqueTransactionGuards } from '../runtime/environment.js';
import { readProjectMode } from '../product/project-mode.js';
import { decodeCoverageCell, type CoverageCell } from './coverage.js';
import type { DiscoveryDraft } from './discovery.js';
import { readExact } from './projection-reader.js';
import { readVariantScope, readCurrentVariantScope, type ProvenVariantScope } from './variant-scope.js';
import { readVariantSnapshot } from './variant-snapshot.js';
import { variantSame } from './discovery-variants.js';
import { currentPlan, provePlanQuestions, type V7PlanQuestion } from './v7-plan-questions.js';

/** DR5 5.2-F (codex-omg №9189, №9615): the closed form and the pure address of
 * the preparation of one deep step — the addressed part of it, not a
 * replacement of the common transport or managed intent. It names one exact
 * coverage cell (the whole discovery-coverage-cell/v1 form of 5.1-F, kept
 * verbatim: no depth check by its text) and the exact discovery-variant-scope
 * of the same project; the project and the subject come only from the cell.
 * The whole scope is in the hash: another decision or mode expressed by a new
 * exact scope is another preparation and another future paid identity, while
 * the cell key stays the same. Structural only: no ready, accepted or paid
 * mark, no write, no head read and no permission to dispatch; a missing scope
 * never falls back to a broad step. The origin of the scope and its equality
 * to the cell's project, set and member, the chosen decision or mode and the
 * question of the accepted plan are proven by the main 5.2 through 4P — an id
 * prefix proves none of that. */
export const DISCOVERY_DEEP_PREPARATION_KIND = 'discovery-deep-preparation' as const;
export const DISCOVERY_DEEP_PREPARATION_CONTRACT = 'discovery-deep-preparation/v1' as const;

export interface DeepPreparation { contract: typeof DISCOVERY_DEEP_PREPARATION_CONTRACT; cell: CoverageCell; scope: Ref }

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_deep_preparation_invalid', `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as a ready mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed deep preparation form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the deep preparation form');
}
/** The accepted 5.1-F cell form; its refusal keeps the address of the nested field under `cell`. */
function cell(value: unknown): CoverageCell {
  try { return decodeCoverageCell(value); } catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'discovery_coverage_invalid') throw error;
    const nested = String((error.details as { field?: unknown } | null)?.field ?? '').replace(/^cell(\.|$)/, '');
    invalid(nested ? `cell.${nested}` : 'cell', `The coverage cell is refused: ${error.message}`);
  }
}

/** The closed form of a deep preparation; the input is never mutated — the result is a copy. */
export function decodeDeepPreparation(value: unknown): DeepPreparation {
  if (!object(value) || value.contract !== DISCOVERY_DEEP_PREPARATION_CONTRACT)
    invalid('contract', `Only ${DISCOVERY_DEEP_PREPARATION_CONTRACT} is a known deep preparation form; another version is never read as this one`);
  shape(value, ['contract', 'cell', 'scope'], 'preparation');
  const decoded = cell(value.cell);
  shape(value.scope, ['id', 'revision', 'hash'], 'scope');
  if (!isRef(value.scope)) invalid('scope', 'Expected the exact reference of the variant scope');
  if (!value.scope.id.startsWith(`discovery-variant-scope:${decoded.projectId}:`))
    invalid('scope', 'The scope is a variant scope of the cell project');
  return structuredClone(value) as unknown as DeepPreparation;
}

/** The pure address: the same content gives the same address whatever its JSON key
 * order; any component of the cell or any id, revision or hash of the scope gives another. */
export function deepPreparationId(value: unknown): string {
  const decoded = decodeDeepPreparation(value);
  return `${DISCOVERY_DEEP_PREPARATION_KIND}:${decoded.cell.projectId}:${hashJson(decoded as unknown as Json)}`;
}
/** The pure projector — the data of the record at its first revision; nothing is written or dispatched. */
export function projectDeepPreparation(value: unknown):
  { kind: typeof DISCOVERY_DEEP_PREPARATION_KIND; id: string; revision: 1; value: DeepPreparation } {
  const decoded = decodeDeepPreparation(value);
  return { kind: DISCOVERY_DEEP_PREPARATION_KIND, id: deepPreparationId(decoded), revision: 1, value: decoded };
}

export interface ProvenDeepPreparation {
  verification: 'proven'; preparation: Revision<DeepPreparation>;
  scope: ProvenVariantScope; draft: Revision<DiscoveryDraft>; question: V7PlanQuestion;
}
export interface CurrentDeepPreparation extends ProvenDeepPreparation { guards: TransactionGuard[] }

function requireStore(store: Store, project: string): void {
  if (!(store instanceof Store) || typeof project !== 'string' || !project.length)
    invalid('store', 'A deep preparation requires its Store and project');
}
function stale(field: string): never {
  throw new EngineError('discovery_deep_preparation_stale', 'The deep preparation no longer names the current admission', { field });
}

/** Common historical proof for both creation and reading; no current head decides its subject. */
function provePreparation(store: Store, project: string, value: DeepPreparation): Omit<ProvenDeepPreparation, 'preparation'> {
  if (value.cell.projectId !== project) invalid('cell.projectId', 'The cell belongs to this project');
  const scope = readVariantScope(store, project, value.scope), selected = scope.scope.value;
  if (!variantSame(value.cell.variant.set, selected.set)) invalid('cell.variant.set', 'The cell names the scope\'s exact set');
  if (!variantSame(value.cell.variant.member, selected.member)) invalid('cell.variant.member', 'The cell names the scope\'s chosen exact member');
  const draft = readExact<DiscoveryDraft>(store, selected.draft);
  if (!draft || draft.kind !== 'discovery-draft' || draft.value.projectId !== project || hashJson(draft.value) !== draft.hash)
    invalid('scope.draft', 'The scope retains its exact project draft');
  const subject = scope.generation.session.value.variantSubject;
  if (subject.kind !== 'proposal') invalid('scope', 'The selected set comes from a generation');
  const snapshot = readVariantSnapshot(store, project, subject.snapshot);
  if (!variantSame(snapshot.value.draft, selected.draft)) invalid('scope.draft', 'Scope and generation share their exact draft');
  if (!variantSame(snapshot.value.plan, value.cell.subject.planAnswer))
    invalid('cell.subject.planAnswer', 'The cell names the exact plan of the selected generation');
  const questions = provePlanQuestions(store, draft, value.cell.subject.planAnswer);
  const matches = questions.filter(item => item.planQuestionId === value.cell.subject.planQuestionId);
  if (matches.length !== 1) invalid('cell.subject.planQuestionId', 'The exact accepted plan proves this one question');
  const question = matches[0]!, body = question.question as Record<string, Json>;
  for (const field of ['requiredDepth', 'criterion'] as const)
    if (body[field] !== value.cell[field]) invalid(`cell.${field}`, 'The cell keeps the proven question text verbatim');
  return { verification: 'proven', scope, draft, question };
}

/** Exact historical reader. A proven saved preparation never authorizes a new dispatch or reactivates its selection. */
export function readDeepPreparation(store: Store, project: string, ref: Ref): ProvenDeepPreparation {
  requireStore(store, project);
  if (!isRef(ref)) invalid('preparation', 'An exact deep preparation Ref is required');
  const record = readExact<DeepPreparation>(store, ref);
  if (!record || record.kind !== DISCOVERY_DEEP_PREPARATION_KIND || record.revision !== 1 || hashJson(record.value) !== record.hash)
    invalid('preparation', 'The exact immutable deep preparation is missing or substituted');
  const value = decodeDeepPreparation(record.value);
  if (record.id !== deepPreparationId(value)) invalid('preparation.id', 'The address is derived from the whole cell and scope');
  return { ...provePreparation(store, project, value), preparation: record };
}

function currentGuards(store: Store, project: string, value: DeepPreparation,
  proof: Omit<ProvenDeepPreparation, 'preparation'>): TransactionGuard[] {
  const plan = currentPlan(store, project), selected = proof.scope.scope.value;
  if (!variantSame(reference(plan.draft), reference(proof.draft))) stale('draft');
  if (!variantSame(plan.planAnswer, value.cell.subject.planAnswer)) stale('plan');
  const scope = readCurrentVariantScope(store, project, reference(plan.draft));
  if (!variantSame(reference(scope.scope), value.scope)) stale('scope');
  const mode = readProjectMode(store, project);
  if (!variantSame(mode.ref, selected.mode)) stale('mode');
  const guards = uniqueTransactionGuards([reference(plan.draft), reference(plan.question), plan.planAnswer,
    value.scope, selected.set, selected.member, selected.decision, reference(scope.state), mode.ref]);
  if (!transactionGuardsCurrent(store, guards)) stale('guards');
  return guards;
}

/** Admission for 5.3: callers supply only the exact Ref, never a trusted body or a substitute guard list.
 * These mandatory guards must join the managed dispatch transaction. Historical reads alone are insufficient. */
export function requireCurrentDeepPreparation(store: Store, project: string, ref: Ref): CurrentDeepPreparation {
  const proof = readDeepPreparation(store, project, ref);
  const guards = uniqueTransactionGuards([...currentGuards(store, project, proof.preparation.value, proof), ref]);
  if (!transactionGuardsCurrent(store, guards)) stale('guards');
  return { ...proof, guards };
}

/** One immutable preparation of the current exact subject. It neither asserts missing coverage nor buys work.
 * A repeat checks current admission again; only the separate exact reader can read an old, inactive preparation. */
export function produceDeepPreparation(store: Store, project: string, input: unknown):
  { record: Revision<DeepPreparation>; repeated: boolean } {
  requireStore(store, project);
  const projected = projectDeepPreparation(input), existing = store.get(projected.id);
  if (existing) {
    const proof = requireCurrentDeepPreparation(store, project, reference(existing));
    return { record: proof.preparation, repeated: true };
  }
  const proof = provePreparation(store, project, projected.value);
  const guards = currentGuards(store, project, projected.value, proof);
  const record = store.writeMany<DeepPreparation>([{ id: projected.id, kind: projected.kind, expected: 0, value: projected.value }], guards)[0]!;
  return { record, repeated: false };
}

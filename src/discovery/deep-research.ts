import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { decodeCoverageCell, type CoverageCell } from './coverage.js';

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

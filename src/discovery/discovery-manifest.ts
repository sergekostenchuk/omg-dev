import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';

/** DR7 7b.2-F (codex-omg №9189, №9660): the closed structural form of one
 * manifest of the final Discovery bundle. It addresses the exact draft, the one
 * saved record of the whole D7 bundle (no separate acceptance links or copies of
 * its summary, projection or constitution), its exact assessment, the admission
 * — the owner act or the saved machine admission — the previous manifest and the
 * records resolving its conditions. The admission kind proves no authority: the
 * mode, the project policy, the author and the scope come from the proven record
 * it names; a boolean or a bypass string never stands for that ground. The
 * resolutions are addresses of grounds, not flags of fulfilled conditions. The
 * form decides no outcome — the single outcome lives in the addressed bundle and
 * is read by the 7a.1 form on a proving read. Structural only: no accepted,
 * supported or ready mark, no outcome copy; the reader checks only its own exact
 * record and is not the reader of an accepted Discovery. The producer, the paid
 * assessment, the authority and the atomic acceptance are the main 7b.2; the
 * proof of resolutions and of previous is 7b.3. */
export const DISCOVERY_MANIFEST_KIND = 'discovery-manifest' as const;
export const DISCOVERY_MANIFEST_CONTRACT = 'discovery-manifest/v7' as const;
export const DISCOVERY_MANIFEST_ADMISSIONS = Object.freeze(['owner', 'machine'] as const);

export interface DiscoveryManifestAdmission { kind: typeof DISCOVERY_MANIFEST_ADMISSIONS[number]; record: Ref }
export interface DiscoveryManifest {
  contract: typeof DISCOVERY_MANIFEST_CONTRACT; projectId: string;
  draft: Ref; bundle: Ref; assessment: Ref; admission: DiscoveryManifestAdmission;
  previous: Ref | null; resolutions: Ref[];
}
export interface DiscoveryManifestView { get<T = unknown>(id: string, revision?: number): Revision<T> | null }
/** A structural read result — deliberately not an accepted Discovery. */
export interface StructuralDiscoveryManifest { verification: 'structural'; record: Revision<DiscoveryManifest> }

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('discovery_manifest_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as an accepted mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed manifest form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the manifest form');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}

/** The closed form of one manifest. An unknown contract or admission branch is refused, never read as this one. */
export function decodeDiscoveryManifest(value: unknown): DiscoveryManifest {
  if (!object(value) || value.contract !== DISCOVERY_MANIFEST_CONTRACT)
    invalid('contract', `Only ${DISCOVERY_MANIFEST_CONTRACT} is a known manifest form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'draft', 'bundle', 'assessment', 'admission', 'previous', 'resolutions'], 'manifest');
  if (typeof value.projectId !== 'string' || !value.projectId.trim()) invalid('projectId', 'Expected nonempty text');
  ref(value.draft, 'draft'); ref(value.bundle, 'bundle'); ref(value.assessment, 'assessment');
  if (!object(value.admission) || !(DISCOVERY_MANIFEST_ADMISSIONS as readonly unknown[]).includes(value.admission.kind))
    invalid('admission.kind', 'An admission is the owner act or the saved machine admission');
  shape(value.admission, ['kind', 'record'], 'admission');
  ref(value.admission.record, 'admission.record');
  if (value.previous !== null) {
    ref(value.previous, 'previous');
    if (!value.previous.id.startsWith(`${DISCOVERY_MANIFEST_KIND}:${value.projectId}:`))
      invalid('previous', 'A previous manifest is a manifest of this project');
  }
  const resolutions = value.resolutions;
  if (!Array.isArray(resolutions)) invalid('resolutions', 'Expected the list of condition resolution records');
  resolutions.forEach((item: unknown, i: number) => ref(item, `resolutions.${i}`));
  if (new Set(resolutions.map(item => canonical(item))).size !== resolutions.length)
    invalid('resolutions', 'Each resolution record is named once');
  return structuredClone(value) as unknown as DiscoveryManifest;
}

/** The canonical address of a manifest: immutable, content-addressed, revision 1. */
export function discoveryManifestId(value: { projectId: string }): string {
  return `${DISCOVERY_MANIFEST_KIND}:${value.projectId}:${hashJson(value as never)}`;
}
/** The pure projector — the full composition and its address at revision 1; the input is never mutated. */
export function projectDiscoveryManifest(value: unknown): { id: string; revision: 1; value: DiscoveryManifest } {
  const decoded = decodeDiscoveryManifest(value);
  return { id: discoveryManifestId(decoded), revision: 1, value: decoded };
}
/** The exact structural reader of the manifest record itself: its exact Ref, kind,
 * project, canonical address and first revision, in the closed form. It proves no
 * accepted Discovery and reads no head. */
export function readDiscoveryManifestStructural(view: DiscoveryManifestView, project: string, at: Ref): StructuralDiscoveryManifest {
  ref(at, 'record');
  if (!view || typeof view.get !== 'function') invalid('view', 'An exact record reader is required');
  const row = view.get<unknown>(at.id, at.revision);
  if (!row || row.kind !== DISCOVERY_MANIFEST_KIND || !Object.hasOwn(row, 'value')
    || canonical(reference(row)) !== canonical(at) || hashJson(row.value as never) !== at.hash)
    invalid('record', 'The exact record kind, revision or content hash does not match', at);
  const value = decodeDiscoveryManifest(row.value);
  if (value.projectId !== project || row.id !== discoveryManifestId(value) || row.revision !== 1)
    invalid('record', 'Foreign project or noncanonical manifest address', at);
  return { verification: 'structural', record: { ...row, value } };
}

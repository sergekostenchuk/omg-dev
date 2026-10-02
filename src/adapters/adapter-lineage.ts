import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import { stdioProviderByModule } from './stdio-providers.js';
import { canonical, digest, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { Store } from '../storage/store.js';
import type { ModelCall } from '../runtime/model-usage.js';

export interface AdapterLineageDeclaration { path: string; sha256: string; basis: string[] }
export interface AdapterLineage extends AdapterLineageDeclaration { projectId: string; declaredBy: string }
export const validAdapterHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Normalize only the host's real /var alias, even after the leaf disappeared.
 * No filename/basename fallback may turn a different path into this lineage. */
export function adapterLineagePath(path: string): string {
  requireCondition(typeof path === 'string' && isAbsolute(path) && !path.includes('\0'),
    'adapter_lineage_path_invalid', 'Lineage requires an exact absolute adapter path');
  const result = normalize(path);
  if (process.platform === 'darwin' && result.startsWith('/var/') && realpathSync('/var') === '/private/var') return '/private' + result;
  return result;
}
const lineageId = (project: string, path: string) => `adapter-lineage:${hashJson([project, path])}`;
const validBasis = (basis: unknown): basis is string[] => Array.isArray(basis) && basis.length > 0
  && basis.every(value => typeof value === 'string' && value.trim().length > 0);

/** Only a genuinely absent old file can use an operator's historical record.
 * Permission and I/O errors must not be disguised as absence. */
export function adapterFileHash(path: string): string | null {
  try { return digest(readFileSync(path)); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return null;
    throw error;
  }
}

export function adapterLineage(store: Store, project: string, path: string) {
  const normalized = adapterLineagePath(path), record = store.get<AdapterLineage>(lineageId(project, normalized));
  if (!record) return null;
  requireCondition(record.kind === 'adapter-lineage' && record.revision === 1 && record.value.projectId === project
    && record.value.path === normalized && validAdapterHash(record.value.sha256) && validBasis(record.value.basis)
    && typeof record.value.declaredBy === 'string' && record.value.declaredBy.trim(),
    'adapter_lineage_invalid', 'Historical adapter identity must be the original immutable operator declaration');
  return record;
}

/** An explicit operator command, never an inferred migration or model action.
 * The declaration is an attributed historical assertion, not runtime proof. */
export function declareAdapterLineage(store: Store, project: string, request: AdapterLineageDeclaration, declaredBy: string) {
  requireCondition(typeof project === 'string' && project.trim() && request && validAdapterHash(request.sha256)
    && validBasis(request.basis) && typeof declaredBy === 'string' && declaredBy.trim(),
    'adapter_lineage_invalid', 'Lineage needs its project, SHA-256, explicit evidence and actual declaring operator');
  const path = adapterLineagePath(request.path), current = adapterFileHash(path);
  requireCondition(current === null || current === request.sha256, 'adapter_lineage_hash_conflict', 'A declaration cannot contradict existing adapter bytes');
  requireCondition(store.list<ModelCall>('model-call').some(call => {
    const entry = call.value.requested?.command.args[0];
    return call.value.projectId === project && typeof entry === 'string' && isAbsolute(entry)
      && stdioProviderByModule(basename(entry)) !== null && adapterLineagePath(entry) === path;
  }), 'adapter_lineage_path_unknown', 'The declaration must identify an actual historical adapter path of this project');
  const value: AdapterLineage = { projectId: project, path, sha256: request.sha256, basis: [...request.basis], declaredBy };
  const existing = adapterLineage(store, project, path);
  if (existing) {
    requireCondition(canonical(existing.value) === canonical(value), 'adapter_lineage_conflict', 'An existing path declaration cannot be replaced');
    return existing;
  }
  return store.write<AdapterLineage>({ id: lineageId(project, path), kind: 'adapter-lineage', expected: 0, value });
}

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage/store.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const { sampleReader } = await import(new URL('../../scripts/golden-sample.mjs', import.meta.url).href);
const reader = sampleReader(root);
/** Historical readers only. Public task-context gates require their own live workspace. */
export function goldenSample(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(root, '.golden-test-')), database = join(directory, 'state.sqlite');
  let store: Store | undefined;
  t.after(() => { try { store?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const meta = reader.copy(database);
  store = new Store(database);
  return { directory, database, store, meta };
}

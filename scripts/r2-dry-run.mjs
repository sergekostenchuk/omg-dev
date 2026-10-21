// Uses an online SQLite backup and a local deterministic protocol fixture only.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { Store } from '../dist/src/storage/store.js';
import { ProductEngine } from '../dist/src/product/engine.js';
import { previewResearch } from '../dist/src/discovery/research-preview.js';
const [sourcePath, outPath, option, previewDraft] = process.argv.slice(2);
if (!sourcePath || !outPath) throw Error('Usage: node scripts/r2-dry-run.mjs SOURCE_SQLITE NEW_OUTPUT_DIRECTORY [--preview EXACT_R2_DRAFT_ID]');
// LG83: the ordinary R2 dry-run mode is closed. Its budget-reserve producer was
// removed with the R2 route (LG62); it is refused by name before any output
// directory is created or the source copy is taken.
if (option !== '--preview') throw Error('r2_dry_run_mode_removed: the ordinary R2 dry-run mode is closed; only --preview EXACT_R2_DRAFT_ID remains');
if (!previewDraft) throw Error('Preview requires the exact prepared R2 draft ID in the source copy');
const out = resolve(outPath); mkdirSync(out, { recursive: false });
const db = join(out, 'copy.sqlite');
const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
source.exec('PRAGMA query_only=ON');
try { await backup(source, db); } finally { source.close(); }
const store = new Store(db), engine = new ProductEngine(store);
try {
  const draft = store.get(previewDraft);
  if (draft?.kind !== 'discovery-draft' || draft.value.stage !== 'om-g2' || draft.value.level !== 'R2' || draft.value.consumer !== 'compilation') throw Error('Preview must name a technical R2 draft');
  const before = store.list('model-call').length;
  const captured = await previewResearch(() => engine.researcher.run(draft.value.projectId, draft.id, 1));
  assert.equal(store.list('model-call').length, before, 'Preview must not create model-call or synthetic usage');
  const request = join(out, 'request.json'); writeFileSync(request, captured.input);
  const { input: _input, ...metadata } = captured;
  const report = { previewOnly: true, paidCalls: 0, source: resolve(sourcePath), copy: db, request, ...metadata };
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { store.close(); }
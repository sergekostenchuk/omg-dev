import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

/** The real fixture adapter normally reads every page. Deliberately answer
 * early once, to exercise the product's saved context refusal and recovery. */
export function answerBeforeContext(root: string): () => void {
  const path = root + '/adapter.mjs', original = readFileSync(path, 'utf8');
  const loop = 'for(const a of r.subject.working?.materialAddresses??[])';
  assert.ok(original.includes(loop), 'the fixture uses its real bounded reader');
  writeFileSync(path, original.replace(loop, 'for(const a of [])'));
  return () => writeFileSync(path, original);
}

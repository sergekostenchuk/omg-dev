import { canonical, digest, hashJson, type Json } from '../canonical.js';
import type { Source } from '../evidence/evidence.js';
import type { Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';
import type { RuntimeCheck } from '../graph/obligation-policy.js';
import type { ProcessResult } from './process.js';
import type { Command } from '../graph/model.js';

export interface RuntimeObservation {
  version: 1;
  projectId: string; key: string; scope: Ref; requestedFor: string; check: RuntimeCheck;
  environment: Ref; context: Ref[]; root: string; codeRoot: string | null;
  runtimeBinding: Json;
  platform: { os: string; release: string; arch: string; node: string };
  executable: { path: string; hash: string; identity: {dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number} };
  subjects: (RuntimeObservation['executable'] & {requested:string;kind:'file'|'executable'})[];
  snapshot: string | null; invocation: Command | null;
  owner: { pid: number; started: string }; child: { pid: number; started: string } | null;
  startedAt: number; finishedAt: number | null;
  status: 'running' | 'observed' | 'failed' | 'stale'; result: ProcessResult | null; error: string | null;
}

/** A completed invocation is an observation, including a nonzero exit. It is
 * not an automatic verdict that the claimed runtime capability exists. */
export function runtimeSource(record: Revision<RuntimeObservation>) {
  const ref = { id:record.id,revision:record.revision,hash:record.hash };
  const content = canonical({ protocol:'omg-runtime-observation/v1',observation:ref,scope:record.value.scope,environment:record.value.environment,
    root:record.value.root,codeRoot:record.value.codeRoot,runtimeBinding:record.value.runtimeBinding,check:record.value.check,platform:record.value.platform,executable:record.value.executable,subjects:record.value.subjects,invocation:record.value.invocation,
    startedAt:record.value.startedAt,finishedAt:record.value.finishedAt,result:record.value.result,
    proofLimit:'executed-command-observation; relevance and sufficiency require assessment' });
  const value: Source = {projectId:record.value.projectId,origin:{kind:'owner-document',location:`runtime-observation:${record.id}@${record.revision}`},
    content,mediaType:'application/json',sha256:digest(content),provenance:{kind:'runtime-observation',record:ref}};
  return {id:`source:${record.value.projectId}:runtime-${hashJson(ref)}`,value};
}

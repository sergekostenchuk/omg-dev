import type { Store, Revision } from '../storage/store.js';
import { Evidence, type Observation, type Source } from '../evidence/evidence.js';
import { canonical, hashJson } from '../canonical.js';
import { reference, isRef, type Ref } from '../pipeline/contracts.js';
import type { ReaderResult, ReaderSource } from './reader.js';
import { requireCondition, EngineError } from '../errors.js';

/** Reuse original bytes, not the old question's purpose, verdict or unresolved
 * conclusions. Coverage annotates the requested window; it never cuts the
 * enclosing conditions out of a partially covered reader request. */
export function reusableReaderRanges(store: Store, project: string, supplied: ReaderSource[]) {
  const evidence=new Evidence(store), observations:Observation[]=[], origins:Ref[]=[];
  const missing:{source:Ref;range:{start:number;end:number}}[]=[];
  const covered:{source:Ref;start:number;end:number;readerResult:Ref;pointer:string}[]=[];
  // D8.4.1 (№2314 S1–S4): every candidate of this project is proven as a whole by the common
  // historical reader BEFORE any of its bytes is selected — a copy with a recomputed address, a
  // substituted coverage/observation or a lost basis is the reader's addressed refusal, never a
  // silently skipped candidate. Today's admission of each observation (S2) follows separately.
  const records=provenReaderResults(store,project,()=>true);
  for(const source of supplied){
    const intervals:{start:number;end:number}[]=[];
    for(const record of records) for(const [index,observation] of record.value.observations.entries()){
      if(observation.projectId!==project||canonical(observation.source)!==canonical(source.ref)||observation.selector.kind!=='text-range'||!evidence.verify(observation))continue;
      const start=Math.max(source.visibleRange.start,observation.selector.start),end=Math.min(source.visibleRange.end,observation.selector.end);
      if(start>=end)continue;
      intervals.push({start,end});
      observations.push(start===observation.selector.start&&end===observation.selector.end?observation:
        {...observation,selector:{kind:'text-range',start,end},value:String(observation.value).slice(start-observation.selector.start,end-observation.selector.start)});
      covered.push({source:source.ref,start,end,readerResult:reference(record),pointer:`/observations/${index}`});
      origins.push(reference(record));
    }
    let cursor=source.visibleRange.start;
    for(const interval of intervals.sort((a,b)=>a.start-b.start||a.end-b.end)){
      if(interval.start>cursor)missing.push({source:source.ref,range:{start:cursor,end:interval.start}});
      cursor=Math.max(cursor,interval.end);
    }
    if(cursor<source.visibleRange.end)missing.push({source:source.ref,range:{start:cursor,end:source.visibleRange.end}});
  }
  return {observations:[...new Map(observations.map(o=>[hashJson(o),o])).values()],
    reusedFrom:[...new Map(origins.map(ref=>[canonical(ref),ref])).values()],missing,
    covered:[...new Map(covered.map(item=>[canonical([item.source,item.start,item.end]),item])).values()]};
}

/** Index the originals before another question buys extraction. Their bodies
 * remain at exact addresses; no old proposal, verdict or purpose is imported. */
export function priorReaderIndex(store:Store,project:string,question:string){
  const evidence=new Evidence(store),seen=new Set<string>();
  const index:{source:Ref;selector:Observation['selector'];chars:number;location:string;original:{record:Ref;pointer:string}}[]=[];
  // The scope is "another question of this project"; a candidate whose question is not a provable
  // reference is not provably another question — it reaches the common reader, which refuses it.
  for(const record of provenReaderResults(store,project,record=>!isRef(record.value.question)||record.value.question.id!==question)){
    for(const [offset,observation] of record.value.observations.entries()){
      if(observation.projectId!==project||observation.selector.kind!=='text-range'||!evidence.verify(observation))continue;
      const key=hashJson([observation.source,observation.selector]);
      if(seen.has(key))continue;seen.add(key);
      index.push({source:observation.source,selector:observation.selector,chars:observation.selector.end-observation.selector.start,
        location:store.get<Source>(observation.source.id,observation.source.revision)!.value.origin.location,
        original:{record:reference(record),pointer:`/observations/${offset}`}});
    }
  }
  return index;
}

/** D8.4.1: the scan's scope is the project (and the question where the caller narrows it); inside
 * that scope each candidate is proven exactly by the shared historical reader before its bytes are
 * considered. The proof does not consult today's Source heads or files; that is the separate
 * current admission applied afterwards, observation by observation. */
/** The shared historical reader of reader-result (reader.ts:readReaderResultAt). This leaf is
 * imported by reader.ts at load, so it cannot import reader.ts back without joining the import ring
 * (№32, the ratchet); the reader is bound here by pilot-context.ts — a consumer that already sits
 * inside the ring — when that module loads, before any scan can run. Without a bound reader no
 * candidate is used: the scan refuses, it never falls back to an unproven record. */
export type ReaderResultProof=(store:Store,project:string,ref:Ref)=>Revision<ReaderResult>;
// Process state, closed by default and bound once (№2353, after registerAnswersSourceReader): the
// slot is set by the first bound function and never replaced — a repeat of the same function has no
// effect, another function is a typed conflict that keeps the established binding, a non-function
// is a typed refusal that leaves the slot untouched. No reset, no replacement, no fallback prover.
let readerResultProof:ReaderResultProof|null=null;
export function bindReaderResultProof(prove:ReaderResultProof):void{
  requireCondition(typeof prove==='function','reader_proof_invalid','The shared reader result proof is a function');
  if(readerResultProof===prove)return;
  if(readerResultProof!==null)
    throw new EngineError('reader_proof_conflict','The shared reader result proof is bound already, and another function does not replace it',
      { field:'readerResultProof' });
  readerResultProof=prove;
}
function provenReaderResults(store:Store,project:string,inScope:(record:Revision<ReaderResult>)=>boolean):Revision<ReaderResult>[]{
  const prove=readerResultProof;
  if(prove===null) throw new EngineError('reader_result_invalid','The shared reader result proof is not bound; no saved reading can be used',
    { reason:'proof-unbound' });
  // №2332-1: no mandatory field is used before the proof. The scope reads only the claimed project
  // (a record without a readable body claims no project and belongs to no scope); every candidate of
  // this project — including one whose question or other mandatory field is unreadable — goes to
  // the common reader, which refuses it with its address instead of an untyped exception.
  return store.list<ReaderResult>('reader-result')
    .filter(record=>record.value!==null&&typeof record.value==='object'&&!Array.isArray(record.value)
      &&record.value.projectId===project&&inScope(record))
    .map(record=>prove(store,project,reference(record)));
}

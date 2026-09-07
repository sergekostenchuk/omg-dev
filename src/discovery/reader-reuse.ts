import type { Store } from '../storage/store.js';
import { Evidence, type Observation, type Source } from '../evidence/evidence.js';
import { canonical, hashJson } from '../canonical.js';
import { reference, type Ref } from '../pipeline/contracts.js';
import type { ReaderResult, ReaderSource } from './reader.js';

/** Reuse original bytes, not the old question's purpose, verdict or unresolved
 * conclusions. Coverage annotates the requested window; it never cuts the
 * enclosing conditions out of a partially covered reader request. */
export function reusableReaderRanges(store: Store, project: string, supplied: ReaderSource[]) {
  const evidence=new Evidence(store), observations:Observation[]=[], origins:Ref[]=[];
  const missing:{source:Ref;range:{start:number;end:number}}[]=[];
  const covered:{source:Ref;start:number;end:number;readerResult:Ref;pointer:string}[]=[];
  const records=store.list<ReaderResult>('reader-result').filter(record=>record.value.projectId===project);
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

/** Make prior originals visible before the new question buys another reading.
 * This is an evidence projection, never a copied answer or a completeness claim. */
export function priorReaderMaterial(store:Store,project:string,question:string){
  const evidence=new Evidence(store),observations=new Map<string,Observation>(),origins=new Map<string,Ref>();
  for(const record of store.list<ReaderResult>('reader-result')){
    if(record.value.projectId!==project||record.value.question.id===question)continue;
    for(const observation of record.value.observations){
      if(observation.projectId!==project||observation.selector.kind!=='text-range'||!evidence.verify(observation))continue;
      const key=hashJson(observation);
      if(observations.has(key))continue;
      observations.set(key,observation);origins.set(record.id,reference(record));
    }
  }
  if(!observations.size)return null;
  return {purpose:'Exact originals from earlier reading; evaluate them for this question. Previous unresolved, conclusions and judgments are not transferred.',
    observations:[...observations.values()],unresolved:[] as string[],reusedFrom:[...origins.values()],
    coverage:[...observations.values()].map(observation=>{
      const source=store.get<Source>(observation.source.id)!;
      const selector=observation.selector as {kind:'text-range';start:number;end:number};
      return {ref:observation.source,totalChars:source.value.content.length,visibleRange:{start:selector.start,end:selector.end},
        partial:selector.start!==0||selector.end!==source.value.content.length};
    })};
}

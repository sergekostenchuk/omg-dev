import { canonical } from '../canonical.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';

interface Entry { source:Ref;selector:{kind:string;start?:number;end?:number};location?:string }
export interface PriorSourceSummary {source:Ref;location:string;ranges:[number,number][];observations:number;chars:number}

export function priorEvidenceSources(entries:Entry[]):PriorSourceSummary[]{
  requireCondition(Array.isArray(entries),'prior_evidence_invalid','Prior observations need an explicit index');
  const groups=new Map<string,PriorSourceSummary>();
  for(const entry of entries){
    requireCondition(entry&&isRef(entry.source)&&entry.selector?.kind==='text-range'
      &&Number.isSafeInteger(entry.selector.start)&&Number.isSafeInteger(entry.selector.end)
      &&entry.selector.start!>=0&&entry.selector.end!>entry.selector.start!,
    'prior_evidence_invalid','Prior evidence entries need exact sources and nonempty original ranges');
    const key=canonical(entry.source),group=groups.get(key)??{source:entry.source,location:entry.location??entry.source.id,ranges:[],observations:0,chars:0};
    group.ranges.push([entry.selector.start!,entry.selector.end!]);group.observations++;groups.set(key,group);
  }
  for(const group of groups.values()){
    const merged:[number,number][]=[];
    for(const range of group.ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
      const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);
    }
    group.ranges=merged;group.chars=merged.reduce((sum,[start,end])=>sum+end-start,0);
  }
  return [...groups.values()].sort((a,b)=>a.location.localeCompare(b.location)||canonical(a.source).localeCompare(canonical(b.source)));
}

/** Only a bounded source summary crosses the wire. Both complete catalogues
 * remain addressable; a large project does not turn the summary into a new cap. */
export function packPriorEvidence(packet:Record<string,any>,sources:PriorSourceSummary[],archive:Ref,maxChars:number){
  delete packet.priorEvidence;delete packet.priorEvidenceSources;
  if(!sources.length)return;
  const overview={totalSources:sources.length,totalObservations:sources.reduce((n,s)=>n+s.observations,0),
    chars:sources.reduce((n,s)=>n+s.chars,0),sources:[] as PriorSourceSummary[],nextSource:0 as number|null,
    index:{record:archive,pointer:'/body/priorEvidence'},catalogue:{record:archive,pointer:'/body/priorEvidenceSources'},
    instruction:'Source ranges summarize earlier exact observations, not complete research. Use read_source for an original range or page the full catalogues at these addresses. Omitted sources remain available; no verdict or prior conclusion is transferred.'};
  packet.priorEvidence=overview;
  const baseline=JSON.stringify(packet).length;
  // Leave space for the current material/candidate beside historical navigation.
  const limit=baseline+Math.max(0,Math.floor((maxChars-baseline-1024)/2));
  for(const source of sources){
    overview.sources.push(source);
    if(JSON.stringify(packet).length>limit){overview.sources.pop();break;}
  }
  overview.nextSource=overview.sources.length<sources.length?overview.sources.length:null;
}

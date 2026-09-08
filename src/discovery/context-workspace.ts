import { hashJson, canonical } from '../canonical.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';

export interface ContextLookup { record: Ref; pointer: string; value: unknown; page?: {offset:number;end:number;total:number;unit:string;next:number|null} }
export interface ContextWorkspace { entries: { key: string; result: ContextLookup }[]; sinceProgress: number; checkpointedKeys?: string[]; blocked?: string }

/** Packet archives change on every invocation. A lookup's identity belongs to
 * the selected original value and selector, not the envelope containing it. */
export function contextLookupKey(result: ContextLookup): string {
  requireCondition(isRef(result.record)&&typeof result.pointer==='string'&&Object.hasOwn(result,'value'),
    'research_context_invalid','A context lookup requires exact origin, selector and value');
  const origin=result.record.id.startsWith('research-context:') ? 'question-archive' : result.record;
  return hashJson({origin,pointer:result.pointer,page:result.page?{offset:result.page.offset,end:result.page.end,unit:result.page.unit}:null,value:result.value});
}
export function contextWorkspace(value?: ContextWorkspace, legacyFocus?: unknown): ContextWorkspace {
  if(value){
    requireCondition(Array.isArray(value.entries)&&Number.isSafeInteger(value.sinceProgress)&&value.sinceProgress>=0
      &&value.entries.every(e=>e.key===contextLookupKey(e.result)),'research_context_invalid','Saved context workspace is invalid');
    requireCondition(value.checkpointedKeys === undefined || Array.isArray(value.checkpointedKeys)
      && value.checkpointedKeys.every(key => typeof key === 'string' && value.entries.some(entry => entry.key === key)),
    'research_context_invalid', 'Checkpointed context identities must belong to the saved workspace');
    return value;
  }
  if(legacyFocus && typeof legacyFocus==='object' && isRef((legacyFocus as ContextLookup).record)){
    const result=legacyFocus as ContextLookup;return {entries:[{key:contextLookupKey(result),result}],sinceProgress:1};
  }
  return {entries:[],sinceProgress:0};
}
export function addContextLookup(state: ContextWorkspace, result: ContextLookup,
  delivered: ContextLookup[] = state.entries.map(entry => entry.result), _legacyMaxLookups?: number): ContextWorkspace {
  requireCondition(!state.blocked,'research_no_progress',state.blocked??'Context session requires recovery');
  const key=contextLookupKey(result);
  requireCondition(!delivered.some(item=>contextLookupKey(item)===key),'research_no_progress','Requested context is already delivered; repeating its archive cannot justify another model call');
  // Keep the exact paid originals in the session; the packet builder decides
  // which values fit and exposes an address for every omitted value.
  return {...state,entries:[...state.entries.filter(entry=>entry.key!==key),{key,result}],sinceProgress:state.sinceProgress+1};
}
export function contextProgress(state: ContextWorkspace): ContextWorkspace {return {...state,sinceProgress:0,checkpointedKeys:state.entries.map(entry=>entry.key)};}

/** The newest requested original must cross the actual dispatch boundary.
 * Older originals may be replaced by explicit addresses, never by empty data. */
export function requireContextDelivery(expected: ContextLookup[], packet: Record<string, any>): void {
  const delivered = packet.contextWorkspace;
  requireCondition(Array.isArray(delivered),'research_context_undelivered','The packet has no explicit delivered-context set');
  const expectedKeys = new Set(expected.map(contextLookupKey));
  const keys = delivered.map(contextLookupKey);
  requireCondition(keys.every(key=>expectedKeys.has(key))&&new Set(keys).size===keys.length,
    'research_context_undelivered','The delivered context does not match its saved originals');
  const newest = expected.at(-1);
  requireCondition(!newest||keys.includes(contextLookupKey(newest)),
    'research_context_undelivered','The latest requested context was not delivered; use a smaller page before paying the consumer');
  for (const original of expected) if (!keys.includes(contextLookupKey(original))) {
    requireCondition(Array.isArray(packet.contextIndex)&&packet.contextIndex.some((item: any)=>item.key===contextLookupKey(original)
      &&canonical(item.record)===canonical(original.record)&&item.pointer===original.pointer),
    'research_context_undelivered','An omitted original must remain explicitly addressable');
  }
}

/** Full originals remain in the saved archive. Omitted values are represented
 * by selectors and are eligible for delivery again if explicitly requested. */
export function packContextWorkspace(packet: Record<string, any>, maxChars: number, contextChars = maxChars, retention?: { checkpointedKeys: string[] }): void {
  if (!Object.hasOwn(packet,'contextWorkspace')) return;
  const originals = packet.contextWorkspace as ContextLookup[];
  requireCondition(Array.isArray(originals),'research_context_invalid','Context originals must be an array');
  const index = originals.map(result=>({key:contextLookupKey(result),record:result.record,pointer:result.pointer,
    ...(result.page?{page:result.page}:{}),chars:canonical(result.value).length}));
  packet.contextWorkspace=[];
  packet.contextIndex=index;
  // New synthesis packets reserve current originals before conclusions. Earlier
  // checkpointed originals may yield to addresses; new ones must coexist.
  const room = Math.min(contextChars, Math.max(0, retention
    ? maxChars - JSON.stringify(packet).length - 2048
    : maxChars - JSON.stringify(packet).length - 1024));
  const chosen: ContextLookup[] = [];
  if (retention) {
    const done = new Set(retention.checkpointedKeys);
    const required = originals.filter((item, i) => !done.has(contextLookupKey(item)) || i === originals.length - 1);
    requireCondition(canonical(required).length <= room, 'research_context_capacity',
      'The required addressed originals cannot coexist inside the fixed packet; select a bounded page before paying the consumer');
    chosen.push(...required);
    for (const item of originals) if (!required.includes(item) && canonical([...chosen, item]).length <= room) chosen.push(item);
    chosen.sort((a, b) => originals.indexOf(a) - originals.indexOf(b));
  } else for (let i=originals.length-1;i>=0;i--) {
    const result=originals[i]!;
    if (canonical([result,...chosen]).length<=room) chosen.unshift(result);
  }
  packet.contextWorkspace=chosen;
  requireContextDelivery(originals,packet);
}

import { hashJson, canonical } from '../canonical.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { EngineError, requireCondition } from '../errors.js';
import { planResearchContextDelivery, requireResearchContextDelivery, type ResearchDelivery,
  type ResearchMaterialAddress } from './research-delivery.js';

export interface ContextLookup { record: Ref; pointer: string; value: unknown; page?: {offset:number;end:number;total:number;unit:string;next:number|null;encoding?:'canonical-json'} }
export interface ContextCoverage {
  address: string; record: Ref; pointer: string; total: number; unit: 'items' | 'utf16';
  encoding: 'array-items' | 'utf16-string' | 'canonical-json';
  ranges: { offset: number; end: number }[];
  /** An omitted required field has an independent whole-original obligation.
   * A later narrow lookup of the same address cannot erase that obligation. */
  materialRequired?: true;
}
export interface ContextWorkspace { entries: { key: string; result: ContextLookup }[]; sinceProgress: number;
  checkpointedKeys?: string[]; deliveryCoverage?: ContextCoverage[]; blocked?: string }

/** A caller cannot make an arbitrary value into a paid original merely by
 * placing a Ref-shaped object beside it. Derivation is supplied by the exact
 * record reader; this comparison has no store access or side effects. */
export function requireExactContextWorkspace(results: unknown,
  derive: (result: ContextLookup) => ContextLookup): asserts results is ContextLookup[] {
  requireCondition(Array.isArray(results), 'research_context_undelivered',
    'The supplied context workspace needs exact saved originals');
  for (const result of results) {
    requireCondition(result && typeof result === 'object' && isRef(result.record)
      && typeof result.pointer === 'string' && Object.hasOwn(result, 'value'),
    'research_context_undelivered', 'A supplied context lookup lost its origin, selector or value');
    requireCondition(canonical(result) === canonical(derive(result)),
      'research_context_undelivered', 'The supplied context differs from its exact saved original');
  }
}

function coverageShape(result: ContextLookup, fragment?: ResearchDelivery) {
  const encoding: ContextCoverage['encoding'] = fragment?.encoding === 'json-string-fragment' || result.page?.encoding === 'canonical-json'
    || (typeof result.value !== 'string' && !Array.isArray(result.value))
    ? 'canonical-json' : Array.isArray(result.value) ? 'array-items' : 'utf16-string';
  const unit: ContextCoverage['unit'] = encoding === 'array-items' ? 'items' : 'utf16';
  const total = fragment?.served.total ?? result.page?.total
    ?? (encoding === 'canonical-json' ? canonical(result.value).length
      : (result.value as string | unknown[]).length);
  const address = hashJson({ record: result.record, pointer: result.pointer, unit, encoding });
  const offset = fragment?.served.offset ?? result.page?.offset ?? 0;
  const end = fragment?.served.end ?? result.page?.end ?? total;
  return { address, record: result.record, pointer: result.pointer, total, unit, encoding, offset, end };
}

function addCoverage(current: ContextCoverage[], result: ContextLookup, fragment?: ResearchDelivery,
  range?: { offset: number; end: number }): ContextCoverage[] {
  const part = { ...coverageShape(result, fragment), ...(range ?? {}) };
  requireCondition(Number.isSafeInteger(part.total) && Number.isSafeInteger(part.offset)
    && Number.isSafeInteger(part.end) && part.total >= 0 && part.offset >= 0
    && part.end >= part.offset && part.end <= part.total,
    'research_context_invalid', 'A delivered context range needs exact saved bounds');
  const prior = current.find(entry => entry.address === part.address);
  requireCondition(!prior || prior.total === part.total && prior.unit === part.unit && prior.encoding === part.encoding,
    'research_context_invalid', 'Context pages disagree about their saved original');
  const ranges = [...(prior?.ranges ?? []), { offset: part.offset, end: part.end }]
    .sort((a, b) => a.offset - b.offset);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.offset <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return [...current.filter(entry => entry.address !== part.address),
    { address: part.address, record: part.record, pointer: part.pointer,
      total: part.total, unit: part.unit, encoding: part.encoding, ranges: merged,
      ...(prior?.materialRequired ? { materialRequired: true as const } : {}) }];
}

function covered(entry: ContextCoverage | undefined, start: number, end: number): boolean {
  if (!entry) return false;
  return entry.ranges.some(range => range.offset <= start && range.end >= end);
}

function nextUnserved(entry: ContextCoverage | undefined, start: number, end: number): number {
  let next = start;
  for (const range of entry?.ranges ?? []) {
    if (range.end < next) continue;
    if (range.offset > next) break;
    next = Math.max(next, range.end);
    if (next >= end) break;
  }
  return next;
}

/** An oversized array item is read through its own JSON Pointer. The
 * fragment keeps the parent lookup key, so the newest requested read is still
 * proved while the model gets an address whose UTF-16 offsets are meaningful. */
function deliveryOriginal(result: ContextLookup, fragment: ResearchDelivery): ContextLookup {
  if (fragment.original.pointer === result.pointer) return result;
  const first = result.page?.offset ?? 0;
  const pointer = `${result.pointer}/${first}`;
  requireCondition(Array.isArray(result.value) && result.value.length > 0
    && fragment.original.pointer === pointer && fragment.original.page === null,
  'research_context_undelivered', 'The item fragment is not a child of the saved lookup');
  return { record: result.record, pointer, value: result.value[0] };
}

/** Record only bytes/items that actually crossed this paid packet boundary. */
export function recordContextPacket(state: ContextWorkspace, packet: Record<string, any>): ContextWorkspace {
  if (packet.working?.deliveryContract !== 'research-delivery/v1') return state;
  requireContextDelivery(state.entries.map(entry => entry.result), packet);
  let coverage = state.deliveryCoverage ?? [];
  for (const result of packet.contextWorkspace as ContextLookup[])
    coverage = addCoverage(coverage, result);
  for (const fragment of packet.contextDelivery ?? [] as ResearchDelivery[]) {
    const original = state.entries.find(entry => entry.key === fragment.original.key)?.result;
    requireCondition(original, 'research_context_undelivered', 'The fragment lost its exact context lookup');
    coverage = addCoverage(coverage, deliveryOriginal(original, fragment), fragment);
  }
  for (const address of packet.working?.materialAddresses ?? [] as ResearchMaterialAddress[]) {
    const identity = hashJson({ record: address.record, pointer: address.pointer,
      unit: address.unit, encoding: address.encoding });
    const existing = coverage.find(item => item.address === identity);
    requireCondition(!existing || existing.total === address.total,
      'research_context_invalid', 'Material pages disagree about their saved original');
    if (existing) coverage = coverage.map(item => item.address === identity
      ? { ...item, materialRequired: true as const } : item);
    else coverage = [...coverage, { address: identity, record: address.record,
      pointer: address.pointer, total: address.total, unit: address.unit,
      encoding: address.encoding, ranges: [], materialRequired: true }];
  }
  for (const fragment of packet.materialDelivery ?? [] as ResearchDelivery[]) {
    if (!packet.working?.materialAddresses?.length) continue;
    const address = (packet.working?.materialAddresses ?? [] as ResearchMaterialAddress[])
      .find((item: ResearchMaterialAddress) => item.pointer === fragment.original?.pointer
        && canonical(item.record) === canonical(fragment.original?.record));
    if (!address && packet.dispatchMode === 'planning' && packet.working?.navigationAddresses?.some((item: {
      record: Ref; pointer: string; sourceHash: string }) => canonical(item.record) === canonical(fragment.original?.record)
        && item.pointer === fragment.original?.pointer && item.sourceHash === fragment.original?.valueHash)) continue;
    requireCondition(address && address.valueHash === fragment.original.valueHash,
      'research_context_undelivered', 'The material fragment lacks its exact saved address');
    coverage = addCoverage(coverage, { record: address.record, pointer: address.pointer,
      value: fragment.value ?? fragment.text }, fragment);
  }
  // A fully supplied child closes exactly that array item, not the whole
  // parent page. Other items retain their own outstanding ranges.
  for (const entry of state.entries) {
    const parent = entry.result;
    if (!Array.isArray(parent.value) || !parent.value.length) continue;
    const index = parent.page?.offset ?? 0;
    const child = { record: parent.record, pointer: `${parent.pointer}/${index}`, value: parent.value[0] };
    const part = coverageShape(child);
    const seen = coverage.find(item => item.address === part.address);
    if (seen?.ranges.length === 1 && seen.ranges[0]?.offset === 0 && seen.ranges[0].end === seen.total)
      coverage = addCoverage(coverage, parent, undefined, { offset: index, end: index + 1 });
  }
  return { ...state, deliveryCoverage: coverage };
}

export function requireCompleteContextPacket(state: ContextWorkspace, packet: Record<string, any>): void {
  if (packet.working?.deliveryContract !== 'research-delivery/v1') return;
  const recorded = recordContextPacket(state, packet);
  const required = state.entries.map(entry => coverageShape(entry.result));
  const obligations = [...required.map(item => ({ item, start: item.offset, end: item.end })),
    ...(recorded.deliveryCoverage ?? []).filter(item => item.materialRequired)
      .map(item => ({ item, start: 0, end: item.total }))];
  const incomplete = obligations.find(({ item, start, end }) => !covered(
    recorded.deliveryCoverage?.find(entry => entry.address === item.address), start, end));
  if (incomplete) {
    const { item, start, end } = incomplete;
    const entry = recorded.deliveryCoverage?.find(covered => covered.address === item.address);
    throw new EngineError('research_context_incomplete',
      'Read the remaining exact context pages before a final answer',
      { record: item.record, pointer: item.pointer,
        unit: item.unit, total: item.total, ranges: entry?.ranges ?? [],
        requested: { offset: start, end }, next: nextUnserved(entry, start, end) });
  }
}

/** New transports may deliver only the remaining part of an already proved
 * lookup. Its exact original and total stay pinned; old callers retain their
 * existing workspace and delivery sequence. */
export function pendingContextWorkspace(state: ContextWorkspace): ContextWorkspace {
  const pending = state.entries.flatMap(entry => {
    const item = coverageShape(entry.result), coverage = state.deliveryCoverage?.find(row => row.address === item.address);
    requireCondition(!coverage || coverage.total === item.total,
      'research_context_invalid', 'Pending context pages disagree about their saved original');
    const offset = nextUnserved(coverage, item.offset, item.end);
    if (offset >= item.end) return [];
    const end = Math.min(item.end, coverage?.ranges.find(range => range.offset > offset)?.offset ?? item.end);
    if (offset === item.offset && end === item.end) return [entry];
    const value = item.encoding === 'canonical-json' && entry.result.page?.encoding !== 'canonical-json'
      ? canonical(entry.result.value) : entry.result.value as string | unknown[];
    const result: ContextLookup = {record:entry.result.record,pointer:entry.result.pointer,
      value:value.slice(offset-item.offset,end-item.offset),page:{offset,end,total:item.total,unit:item.unit,
        next:end < item.total ? end : null,...(item.encoding === 'canonical-json' ? {encoding:'canonical-json' as const} : {})}};
    return [{key:contextLookupKey(result),result}];
  });
  // Overlapping paid lookups can converge to the same uncovered tail. Deliver
  // that exact range once, retaining its newest position and every saved original.
  const unique = new Map<string, ContextWorkspace['entries'][number]>();
  for (const entry of pending) { unique.delete(entry.key); unique.set(entry.key, entry); }
  const entries = [...unique.values()];
  return {...state,entries,...(state.checkpointedKeys ? {
    checkpointedKeys:state.checkpointedKeys.filter(key => entries.some(entry => entry.key === key))} : {})};
}

/** Packet archives change on every invocation. A lookup's identity belongs to
 * the selected original value and selector, not the envelope containing it. */
export function contextLookupKey(result: ContextLookup): string {
  requireCondition(isRef(result.record)&&typeof result.pointer==='string'&&Object.hasOwn(result,'value'),
    'research_context_invalid','A context lookup requires exact origin, selector and value');
  const origin=result.record.id.startsWith('research-context:') ? 'question-archive' : result.record;
  return hashJson({origin,pointer:result.pointer,page:result.page?{offset:result.page.offset,end:result.page.end,unit:result.page.unit,
    ...(result.page.encoding ? { encoding: result.page.encoding } : {})}:null,value:result.value});
}
export function contextWorkspace(value?: ContextWorkspace, legacyFocus?: unknown): ContextWorkspace {
  if(value){
    requireCondition(Array.isArray(value.entries)&&Number.isSafeInteger(value.sinceProgress)&&value.sinceProgress>=0
      &&value.entries.every(e=>e.key===contextLookupKey(e.result)),'research_context_invalid','Saved context workspace is invalid');
    requireCondition(value.checkpointedKeys === undefined || Array.isArray(value.checkpointedKeys)
      && value.checkpointedKeys.every(key => typeof key === 'string' && value.entries.some(entry => entry.key === key)),
    'research_context_invalid', 'Checkpointed context identities must belong to the saved workspace');
    requireCondition(value.deliveryCoverage === undefined || Array.isArray(value.deliveryCoverage)
      && value.deliveryCoverage.every(entry => typeof entry.address === 'string'
        && isRef(entry.record) && typeof entry.pointer === 'string'
        && entry.address === hashJson({record:entry.record,pointer:entry.pointer,unit:entry.unit,encoding:entry.encoding})
        && Number.isSafeInteger(entry.total)
        && entry.total >= 0 && ['items', 'utf16'].includes(entry.unit)
        && ['array-items', 'utf16-string', 'canonical-json'].includes(entry.encoding)
        && (entry.materialRequired === undefined || entry.materialRequired === true)
        && Array.isArray(entry.ranges) && entry.ranges.every(range => Number.isSafeInteger(range.offset)
          && Number.isSafeInteger(range.end) && range.offset >= 0 && range.end >= range.offset && range.end <= entry.total)),
    'research_context_invalid', 'Saved context coverage needs exact delivered ranges');
    return value;
  }
  if(legacyFocus && typeof legacyFocus==='object' && isRef((legacyFocus as ContextLookup).record)){
    const result=legacyFocus as ContextLookup;return {entries:[{key:contextLookupKey(result),result}],sinceProgress:1};
  }
  return {entries:[],sinceProgress:0};
}
export function addContextLookup(state: ContextWorkspace, result: ContextLookup,
  delivered: ContextLookup[] = state.entries.map(entry => entry.result), _legacyMaxLookups?: number,
  packet?: Record<string, any>): ContextWorkspace {
  requireCondition(!state.blocked,'research_no_progress',state.blocked??'Context session requires recovery');
  const key=contextLookupKey(result);
  requireCondition(!delivered.some(item=>contextLookupKey(item)===key),'research_no_progress','Requested context is already delivered; repeating its archive cannot justify another model call');
  const requested = coverageShape(result);
  const previous = state.deliveryCoverage?.find(entry => entry.address === requested.address);
  requireCondition(!state.entries.some(entry => entry.key === key) || !previous
    || covered(previous, requested.offset, requested.end),
  'research_no_progress', 'This partial context page was already requested; continue at its exact next offset');
  // Keep the exact paid originals in the session; the packet builder decides
  // which values fit and exposes an address for every omitted value.
  const recorded = packet ? recordContextPacket(state, packet) : state;
  return {...recorded,entries:[...recorded.entries,{key,result}],sinceProgress:state.sinceProgress+1};
}
export function contextProgress(state: ContextWorkspace, packet?: Record<string, any>): ContextWorkspace {
  if ((!packet || packet.working?.deliveryContract !== 'research-delivery/v1') && !state.deliveryCoverage)
    return {...state,sinceProgress:0,checkpointedKeys:state.entries.map(entry=>entry.key)};
  const recorded = packet ? recordContextPacket(state, packet) : state;
  const checkpointedKeys = recorded.entries.filter(entry => {
    const part = coverageShape(entry.result);
    const seen = recorded.deliveryCoverage?.find(item => item.address === part.address);
    return covered(seen, part.offset, part.end);
  }).map(entry => entry.key);
  return { ...recorded, sinceProgress:0, checkpointedKeys };
}

/** Fold an admitted historical event, not a new lookup request: replay may
 * move an existing original, while addContextLookup still rejects redelivery. */
export function foldContextEvent(state: ContextWorkspace, action: string, result?: ContextLookup): ContextWorkspace {
  if (['checkpoint', 'answer', 'answer_delta', 'read_bundle', 'read_source'].includes(action))
    return contextProgress(state);
  if (action !== 'read_context') return state;
  requireCondition(result, 'research_context_invalid', 'A context history event needs its proved lookup');
  const key = contextLookupKey(result);
  return { ...state, entries: [...state.entries.filter(entry => entry.key !== key), { key, result }],
    sinceProgress: state.sinceProgress + 1 };
}

/** The newest requested original must cross the actual dispatch boundary.
 * Older originals may be replaced by explicit addresses, never by empty data. */
export function requireContextDelivery(expected: ContextLookup[], packet: Record<string, any>): void {
  const delivered = packet.contextWorkspace;
  requireCondition(Array.isArray(delivered),'research_context_undelivered','The packet has no explicit delivered-context set');
  const expectedKeys = new Set(expected.map(contextLookupKey));
  const keys = delivered.map(contextLookupKey);
  requireCondition(keys.every(key=>expectedKeys.has(key))&&new Set(keys).size===keys.length,
    'research_context_undelivered','The delivered context does not match its saved originals');
  const expectedIndex = expected.map(result => ({ key: contextLookupKey(result),
    record: result.record, pointer: result.pointer,
    ...(result.page ? { page: result.page } : {}), chars: canonical(result.value).length }));
  const indexPage = packet.contextIndexPage;
  if (indexPage !== undefined) {
    const archive = packet.working?.archive;
    requireCondition(isRef(archive) && indexPage?.contract === 'context-index-page/v1'
      && canonical(indexPage.original) === canonical({ record: archive,
        pointer: '/body/contextWorkspace', valueHash: hashJson(expected) })
      && Number.isSafeInteger(indexPage.offset) && indexPage.offset > 0
      && indexPage.end === expectedIndex.length && indexPage.total === expectedIndex.length
      && indexPage.previous === 0
      && canonical(packet.contextIndex) === canonical(expectedIndex.slice(indexPage.offset)),
    'research_context_undelivered', 'The compact index page differs from its saved originals');
  } else requireCondition(canonical(packet.contextIndex) === canonical(expectedIndex),
    'research_context_undelivered', 'The complete context index differs from its saved originals');
  const fragments = packet.contextDelivery === undefined ? [] : packet.contextDelivery;
  requireCondition(Array.isArray(fragments) && fragments.length <= 1,
    'research_context_undelivered', 'The packet has an invalid partial-delivery set');
  for (const fragment of fragments as ResearchDelivery[]) {
    const original = expected.find(item => contextLookupKey(item) === fragment?.original?.key);
    requireCondition(original && !keys.includes(fragment.original.key),
      'research_context_undelivered', 'The partial delivery has no unique saved original');
    requireResearchContextDelivery(deliveryOriginal(original, fragment), contextLookupKey(original), fragment);
  }
  const newest = expected.at(-1);
  requireCondition(!newest||keys.includes(contextLookupKey(newest))
    || fragments.some((fragment: ResearchDelivery) => fragment.original.key === contextLookupKey(newest)),
    'research_context_undelivered','The latest requested context was not delivered; use a smaller page before paying the consumer');
  // A bounded index page carries one exact collection address for older
  // originals; individual entries are still checked against their saved values.
}

/** Full originals remain in the saved archive. Omitted values are represented
 * by selectors and are eligible for delivery again if explicitly requested. */
export function packContextWorkspace(packet: Record<string, any>, maxChars: number, contextChars = maxChars,
  retention?: { checkpointedKeys: string[] }, reserveChars = 1024): void {
  if (!Object.hasOwn(packet,'contextWorkspace')) return;
  const originals = packet.contextWorkspace as ContextLookup[];
  requireCondition(Array.isArray(originals),'research_context_invalid','Context originals must be an array');
  const index = originals.map(result=>({key:contextLookupKey(result),record:result.record,pointer:result.pointer,
    ...(result.page?{page:result.page}:{}),chars:canonical(result.value).length}));
  packet.contextWorkspace=[];
  packet.contextIndex=index;
  const requiredEnvelope = JSON.stringify({ ...packet, contextIndex: [] }).length;
  if (requiredEnvelope > maxChars - reserveChars)
    throw new EngineError('pilot_core_limit',
      'The required question and grounds leave no room for an addressed context index',
      { required: requiredEnvelope, envelopeLimitChars: maxChars });
  const indexBudget = Math.min(Math.floor(maxChars / 4), Math.floor(contextChars / 3),
    Math.max(0, maxChars - JSON.stringify(packet).length + JSON.stringify(index).length - reserveChars - 512));
  if (JSON.stringify(index).length > indexBudget) {
    const archive = packet.working?.archive;
    requireCondition(isRef(archive), 'research_context_capacity',
      'A bounded context index needs the saved archive address');
    packet.contextIndex = [];
    packet.contextIndexPage = { contract: 'context-index-page/v1',
      original: { record: archive, pointer: '/body/contextWorkspace', valueHash: hashJson(originals) },
      offset: index.length, end: index.length, total: index.length, previous: 0 };
    for (let i = index.length - 1; i >= 0; i -= 1) {
      packet.contextIndex.unshift(index[i]);
      packet.contextIndexPage.offset = i;
      if (JSON.stringify(packet.contextIndex).length > indexBudget
        || JSON.stringify(packet).length > maxChars - reserveChars - 256) {
        packet.contextIndex.shift();
        packet.contextIndexPage.offset = i + 1;
        break;
      }
    }
    requireCondition(JSON.stringify(packet).length <= maxChars - reserveChars
      && packet.contextIndexPage.offset > 0,
      'research_context_capacity', 'The exact index address does not fit beside the required question');
  }
  // New synthesis packets reserve current originals before conclusions. Earlier
  // checkpointed originals may yield to addresses; new ones must coexist.
  const room = Math.min(contextChars, Math.max(0, retention
    ? maxChars - JSON.stringify(packet).length - Math.max(2048, reserveChars)
    : maxChars - JSON.stringify(packet).length - reserveChars));
  const chosen: ContextLookup[] = [];
  // Prefer the newest original. Every omitted one retains an
  // exact index address, including a single value larger than the envelope.
  for (let i=originals.length-1;i>=0;i--) {
    const result=originals[i]!;
    if (i === originals.length - 1 && canonical([result]).length > room) break;
    if (canonical([result,...chosen]).length<=room)
      chosen.unshift(result);
  }
  packet.contextWorkspace=chosen;
  const newest = originals.at(-1);
  if (newest && !chosen.some(item => contextLookupKey(item) === contextLookupKey(newest))) {
    const key = contextLookupKey(newest);
    const target = maxChars - (retention ? Math.max(2048, reserveChars) : reserveChars);
    const deliveryLimitChars = Math.max(0, Math.min(contextChars - canonical(chosen).length,
      target - JSON.stringify(packet).length));
    const fits = (candidate: ResearchDelivery) => {
      packet.contextDelivery = [candidate];
      return JSON.stringify(packet).length <= target
        && canonical(chosen).length + JSON.stringify(candidate).length <= contextChars;
    };
    let fragment = deliveryLimitChars > 0
      ? planResearchContextDelivery(newest, key, maxChars, deliveryLimitChars, fits) : null;
    if (fragment?.encoding === 'json-string-fragment' && Array.isArray(newest.value)
      && newest.value.length > 0) {
      const item = { record: newest.record,
        pointer: `${newest.pointer}/${newest.page?.offset ?? 0}`, value: newest.value[0] };
      fragment = planResearchContextDelivery(item, key, maxChars, deliveryLimitChars, fits);
    }
    if (fragment) packet.contextDelivery = [fragment]; else delete packet.contextDelivery;
    requireCondition(fragment, 'research_context_capacity',
      'No positive part of the newest addressed original fits beside the required packet');
  }
  requireContextDelivery(originals,packet);
}

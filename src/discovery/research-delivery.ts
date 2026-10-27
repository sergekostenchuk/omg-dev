import { canonical, digest, hashJson } from '../canonical.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { EngineError, requireCondition } from '../errors.js';

/** A partial transport of one immutable lookup. It never replaces the lookup
 * in the archive or claims that a JSON fragment is the complete value. */
export interface ResearchDelivery {
  contract: 'research-delivery/v1';
  original: { key: string; record: Ref; pointer: string; valueHash: string; page: unknown | null };
  requested: { offset: number; end: number; total: number; unit: 'items' | 'utf16' };
  served: { offset: number; end: number; total: number; next: number | null; unit: 'items' | 'utf16' };
  encoding: 'array-items' | 'utf16-string' | 'json-string-fragment';
  value?: unknown;
  text?: string;
  envelopeLimitChars: number;
  deliveryLimitChars: number;
}

export interface AddressedOriginal {
  record: Ref;
  pointer: string;
  value: unknown;
  page?: { offset: number; end: number; total: number; unit: string; next: number | null;
    encoding?: 'canonical-json' };
}

export interface ResearchMaterialAddress {
  field: string; record: Ref; pointer: string; valueHash: string;
  total: number; unit: 'items' | 'utf16'; encoding: 'array-items' | 'utf16-string' | 'canonical-json';
}

export interface ResearchResultCapacityInput {
  operation: string;
  generation: number;
  bindings: Record<string, unknown>;
  role: 'analyst' | 'assessor' | 'synthesizer';
  purpose: string;
  actionMode: string;
  envelopeLimitChars: number;
  /** Shared exact admission projection, retained once for all permitted forms.
   * Saved history/candidate/evidence bodies belong to addressed delivery. */
  mandatoryEnvelope: Record<string, unknown>;
  /** Its exact saved address when the same projection is already present in
   * the packet archive. The declaration stores the address, not a second body. */
  mandatoryArchive?: { record: Ref; pointer: string; hash: string };
  forms: Array<{ kind: string; specialLimits?: Record<string, number> }>;
}

export interface ResearchResultCapacity {
  contract: 'result-capacity/v1';
  operation: string;
  generation: number;
  bindings: Record<string, unknown>;
  role: ResearchResultCapacityInput['role'];
  purpose: string;
  actionMode: string;
  envelopeLimitChars: number;
  unit: 'utf16';
  mandatory: { projection: Record<string, unknown>; hash: string }
    | { archive: { record: Ref; pointer: string; hash: string } };
  forms: Array<{ kind: string; minimumKey: 'shared'; minimumChars: number; maxResultChars: number;
    specialLimits?: Record<string, number> }>;
}

/** Measure the complete serialized admission once, including its one shared
 * projection and the form table, then replace result:null with the complete
 * normalized reply. This admission envelope is not the next B/A input packet. */
export function buildResearchResultCapacity(input: ResearchResultCapacityInput): ResearchResultCapacity {
  requireCondition(typeof input.operation === 'string' && input.operation.length > 0
    && Number.isSafeInteger(input.generation) && input.generation >= 0
    && Number.isSafeInteger(input.envelopeLimitChars) && input.envelopeLimitChars > 0
    && input.mandatoryEnvelope !== null && typeof input.mandatoryEnvelope === 'object'
    && !Array.isArray(input.mandatoryEnvelope)
    && input.forms.length > 0 && new Set(input.forms.map(form => form.kind)).size === input.forms.length,
  'research_capacity_invalid', 'Result admission needs one exact operation and distinct forms');
  if (input.mandatoryArchive) requireCondition(isRef(input.mandatoryArchive.record)
    && typeof input.mandatoryArchive.pointer === 'string'
    && input.mandatoryArchive.pointer.startsWith('/')
    && input.mandatoryArchive.hash === hashJson(input.mandatoryEnvelope),
  'research_capacity_invalid', 'The addressed mandatory projection needs its exact saved value hash');
  const base = { contract: 'result-capacity/v1' as const,
    operation: input.operation, generation: input.generation, bindings: input.bindings,
    role: input.role, purpose: input.purpose, actionMode: input.actionMode,
    envelopeLimitChars: input.envelopeLimitChars, unit: 'utf16' as const,
    mandatory: input.mandatoryArchive
      ? { archive: input.mandatoryArchive }
      : { projection: input.mandatoryEnvelope, hash: hashJson(input.mandatoryEnvelope) } };
  const minimum = (capacity: typeof base, form: string): number =>
    JSON.stringify(input.mandatoryArchive
      ? { mandatory: input.mandatoryEnvelope, capacity, form, result: null }
      : { capacity, form, result: null }).length - 4;
  let forms: ResearchResultCapacity['forms'] = input.forms.map(form => {
    requireCondition(typeof form.kind === 'string' && form.kind.length > 0,
      'research_capacity_invalid', 'Result form needs a name');
    return { kind: form.kind, minimumKey: 'shared', minimumChars: 0, maxResultChars: 0,
      ...(form.specialLimits ? { specialLimits: form.specialLimits } : {}) };
  });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const capacity = { ...base, forms };
    const measured = forms.map(form => {
      const minimumChars = minimum(capacity, form.kind);
      return { ...form, minimumChars,
        maxResultChars: Math.max(0, input.envelopeLimitChars - minimumChars) };
    });
    if (canonical(measured) === canonical(forms)) break;
    forms = measured;
  }
  const capacity = { ...base, forms };
  for (const form of forms) {
    const minimumChars = minimum(capacity, form.kind);
    requireCondition(minimumChars === form.minimumChars,
      'research_capacity_invalid', 'Result capacity arithmetic did not converge');
    if (minimumChars > input.envelopeLimitChars) throw new EngineError(
      'research_capacity_configuration', 'Mandatory result grounds exceed the admission envelope',
      { form: form.kind, required: minimumChars, envelopeLimitChars: input.envelopeLimitChars });
  }
  return { ...base, forms };
}

/** Verify the saved pre-dispatch contract against the exact producer
 * projection. Historical markerless calls must bypass this new-era check. */
export function requireResearchResultCapacity(saved: unknown,
  input: ResearchResultCapacityInput,
  resolveMandatoryArchive?: (record: Ref, pointer: string) => unknown): asserts saved is ResearchResultCapacity {
  if (input.mandatoryArchive) {
    requireCondition(resolveMandatoryArchive !== undefined,
      'research_capacity_invalid', 'Historical result admission needs its saved mandatory projection');
    const original = resolveMandatoryArchive(input.mandatoryArchive.record,
      input.mandatoryArchive.pointer);
    requireCondition(canonical(original) === canonical(input.mandatoryEnvelope)
      && hashJson(original) === input.mandatoryArchive.hash,
    'research_capacity_invalid', 'The saved mandatory projection differs from its exact archive');
  }
  requireCondition(!!saved && typeof saved === 'object'
    && canonical(saved) === canonical(buildResearchResultCapacity(input)),
  'research_capacity_invalid', 'The result admission differs from its saved producer');
}

export function measureResearchResult(capacity: ResearchResultCapacity,
  formKind: string, normalizedResult: unknown,
  field: 'answer' | 'reasons' | 'citations' | 'checkpoint' | 'need_owner' | 'summary' = 'answer') {
  const form = capacity.forms.find(item => item.kind === formKind);
  requireCondition(!!form, 'research_capacity_invalid', 'The result form is not admitted');
  const serialized = JSON.stringify(normalizedResult);
  requireCondition(typeof serialized === 'string', 'research_capacity_invalid',
    'The result needs a JSON value');
  return researchResultCapacity({ role: capacity.role, field,
    envelopeLimitChars: capacity.envelopeLimitChars,
    requiredEnvelopeChars: form.minimumChars + serialized.length,
    fieldChars: serialized.length });
}

/** Arithmetic for the result-capacity/v1 admission envelope. The field
 * address selects a correction, while fieldChars is the complete serialized
 * result, not an unescaped property inside that result. */
export function researchResultCapacity(input: { role: string; field: 'answer' | 'reasons' | 'citations' | 'checkpoint' | 'need_owner' | 'summary';
  envelopeLimitChars: number; requiredEnvelopeChars: number; fieldChars: number }) {
  const { role, field, envelopeLimitChars, requiredEnvelopeChars, fieldChars } = input;
  requireCondition(typeof role === 'string' && role.trim().length > 0
    && Number.isSafeInteger(envelopeLimitChars) && envelopeLimitChars > 0
    && Number.isSafeInteger(requiredEnvelopeChars) && requiredEnvelopeChars >= 0
    && Number.isSafeInteger(fieldChars) && fieldChars >= 0 && requiredEnvelopeChars >= fieldChars,
  'research_capacity_invalid', 'Result admission needs the measured complete envelope and field');
  const deficitChars = Math.max(0, requiredEnvelopeChars - envelopeLimitChars);
  return { role, field, fits: deficitChars === 0, envelopeLimitChars, requiredChars: requiredEnvelopeChars,
    allowedFieldChars: Math.max(0, fieldChars - deficitChars), deficitChars };
}

type DeliverySource = 'original' | 'context-page';

function request(original: AddressedOriginal, source: DeliverySource, serialized?: string): ResearchDelivery['requested'] {
  if (original.page?.encoding === 'canonical-json') {
    const page = original.page;
    const length = source === 'context-page' ? page.total : (serialized ?? canonical(original.value)).length;
    requireCondition(page.unit === 'utf16' && page.total === length
      && Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.end)
      && Number.isSafeInteger(page.total)
      && page.offset >= 0 && page.end >= page.offset && page.end <= length
      && (source !== 'context-page' || typeof original.value === 'string'
        && original.value.length === page.end - page.offset)
      && page.next === (page.end < length ? page.end : null),
    'research_context_invalid', 'The canonical JSON page needs exact saved UTF-16 bounds');
    return { offset: page.offset, end: page.end, total: length, unit: 'utf16' };
  }
  const unit = Array.isArray(original.value) ? 'items' : 'utf16';
  const valueLength = Array.isArray(original.value) || typeof original.value === 'string'
    ? original.value.length : (serialized ?? canonical(original.value)).length;
  if (!original.page) return { offset: 0, end: valueLength, total: valueLength, unit };
  requireCondition((original.page.unit === 'items' || original.page.unit === 'utf16')
    && original.page.unit === unit && Number.isSafeInteger(original.page.offset)
    && Number.isSafeInteger(original.page.end) && Number.isSafeInteger(original.page.total)
    && original.page.offset >= 0 && original.page.end >= original.page.offset
    && original.page.end - original.page.offset === valueLength
    && original.page.total >= original.page.end,
  'research_context_invalid', 'A delivered page needs exact bounds on its saved original');
  return { offset: original.page.offset, end: original.page.end, total: original.page.total, unit };
}

/** Snapshot JSON without lending the caller's objects to fits. Read keys in
 * canonical order, but retain their insertion order for the actual wire. */
function deliverySnapshot(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value as object))
    throw new EngineError('invalid_json', 'Only finite, acyclic JSON values can be stored');
  seen.add(value as object);
  let result: unknown;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new EngineError('invalid_json', 'Sparse arrays are forbidden');
    result = value.map(item => deliverySnapshot(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new EngineError('invalid_json', 'Only plain objects can be stored');
    const names = Object.keys(value), saved = new Map<string, unknown>();
    for (const name of [...names].sort()) saved.set(name, deliverySnapshot((value as Record<string, unknown>)[name], seen));
    const copy: Record<string, unknown> = Object.create(prototype);
    for (const name of names) Object.defineProperty(copy, name,
      { value: saved.get(name), enumerable: true, writable: true, configurable: true });
    result = copy;
  }
  seen.delete(value as object);
  return result;
}

/** Fit the largest positive prefix against the *actual serialized packet*.
 * If one array item cannot fit, transport an explicitly encoded JSON fragment. */
function planDelivery(original: AddressedOriginal, key: string, envelopeLimitChars: number,
  deliveryLimitChars: number,
  fits: (delivery: ResearchDelivery) => boolean, context: boolean): ResearchDelivery | null {
  // A fit callback can call arbitrary code, including mutating the caller's
  // material or the candidate it receives. Capture the addressed material once
  // and never lend that private snapshot to the callback.
  let record: Ref;
  try { record = deliverySnapshot(original.record) as Ref; }
  catch { throw new EngineError('research_context_invalid', 'An addressed delivery needs its original identity'); }
  const pointer = original.pointer;
  requireCondition(isRef(record) && typeof pointer === 'string' && typeof key === 'string',
    'research_context_invalid', 'An addressed delivery needs its original identity');
  const value = deliverySnapshot(original.value);
  const serialized = canonical(value);
  const sourcePage = original.page;
  const page = sourcePage === undefined ? undefined : deliverySnapshot(sourcePage) as AddressedOriginal['page'];
  const snapshot: AddressedOriginal = { record, pointer, value, ...(page === undefined ? {} : { page }) };
  const source: DeliverySource = context && page?.encoding === 'canonical-json' ? 'context-page' : 'original';
  const requested = request(snapshot, source, serialized);
  const valueHash = digest(serialized);
  const start = requested.offset;
  const canonicalPage = page?.encoding === 'canonical-json';
  const fragment = (count: number, json = false): ResearchDelivery => {
    const encoding = json ? 'json-string-fragment' : Array.isArray(value) ? 'array-items' : 'utf16-string';
    const offset = json && !canonicalPage ? 0 : start;
    const content = json ? source === 'context-page' && canonicalPage
      ? (value as string).slice(0, count) : serialized.slice(offset, offset + count)
      : (value as string | unknown[]).slice(0, count);
    const total = json && !(source === 'context-page' && canonicalPage)
      ? serialized.length : requested.total;
    const end = offset + count;
    return { contract: 'research-delivery/v1',
      original: { key, record: structuredClone(record), pointer, valueHash, page: structuredClone(page ?? null) },
      requested: json && !canonicalPage ? { offset: 0, end: total, total, unit: 'utf16' } : { ...requested },
      envelopeLimitChars, deliveryLimitChars,
      served: { offset, end, total, next: end < total ? end : null,
        unit: json ? 'utf16' : requested.unit }, encoding,
      ...(json ? { text: content as string } : { value: structuredClone(content) }) };
  };
  const isSliceable = !canonicalPage && (typeof value === 'string' || Array.isArray(value));
  if (isSliceable) {
    let low = 0, high = requested.end - start;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(fragment(mid))) low = mid; else high = mid - 1;
    }
    if (low > 0) return fragment(low);
  }
  let low = 0, high = canonicalPage ? requested.end - requested.offset : serialized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(fragment(mid, true))) low = mid; else high = mid - 1;
  }
  return low > 0 ? fragment(low, true) : null;
}

export function planResearchDelivery(original: AddressedOriginal, key: string, envelopeLimitChars: number,
  deliveryLimitChars: number, fits: (delivery: ResearchDelivery) => boolean): ResearchDelivery | null {
  return planDelivery(original, key, envelopeLimitChars, deliveryLimitChars, fits, false);
}

/** Context lookups are already projections of their saved source. Unlike a
 * consolidation original, a canonical-json lookup contains the selected raw
 * UTF-16 page, not the full object from which that page was taken. */
export function planResearchContextDelivery(original: AddressedOriginal, key: string, envelopeLimitChars: number,
  deliveryLimitChars: number, fits: (delivery: ResearchDelivery) => boolean): ResearchDelivery | null {
  return planDelivery(original, key, envelopeLimitChars, deliveryLimitChars, fits, true);
}

/** Verify a saved delivery using only its exact original. The same function is
 * used before dispatch and when the paid packet is read after a cold restart. */
function requireDelivery(original: AddressedOriginal, key: string, delivery: unknown, source: DeliverySource): asserts delivery is ResearchDelivery {
  requireCondition(!!delivery && typeof delivery === 'object', 'research_context_undelivered',
    'The saved fragment is missing');
  const item = delivery as ResearchDelivery;
  requireCondition(item.contract === 'research-delivery/v1' && item.original?.key === key
    && canonical(item.original.record) === canonical(original.record)
    && item.original.pointer === original.pointer
    && item.original.valueHash === hashJson(original.value)
    && canonical(item.original.page) === canonical(original.page ?? null),
  'research_context_undelivered', 'The delivered fragment does not match its saved original');
  const requested = request(original, source), served = item.served;
  if (item.encoding === 'json-string-fragment') {
    const contextPage = source === 'context-page' && original.page?.encoding === 'canonical-json';
    const encoded = contextPage ? original.value as string : canonical(original.value);
    const expected = original.page?.encoding === 'canonical-json' ? requested
      : { offset: 0, end: encoded.length, total: encoded.length, unit: 'utf16' };
    const total = contextPage ? expected.total : encoded.length;
    requireCondition(canonical(item.requested) === canonical(expected)
      && served?.offset === expected.offset && Number.isSafeInteger(served.end)
      && served.end > expected.offset && served.end <= expected.end
      && served.total === total && served.unit === 'utf16'
      && served.next === (served.end < total ? served.end : null)
      && item.text === (contextPage ? encoded.slice(0, served.end - served.offset)
        : encoded.slice(expected.offset, served.end)) && !Object.hasOwn(item, 'value'),
    'research_context_undelivered', 'The JSON fragment differs from the saved original');
  } else {
    requireCondition(!(source === 'context-page' && original.page?.encoding === 'canonical-json')
      && canonical(item.requested) === canonical(requested)
      && served?.offset === requested.offset && Number.isSafeInteger(served.end)
      && served.end > served.offset && served.end <= requested.end && served.total === requested.total
      && served.unit === requested.unit && served.next === (served.end < requested.total ? served.end : null)
      && item.encoding === (Array.isArray(original.value) ? 'array-items' : 'utf16-string')
      && canonical(item.value) === canonical((original.value as string | unknown[]).slice(0, served.end - served.offset))
      && !Object.hasOwn(item, 'text'),
    'research_context_undelivered', 'The delivered page differs from the saved original');
  }
  requireCondition(Number.isSafeInteger(item.envelopeLimitChars) && item.envelopeLimitChars > 0
    && Number.isSafeInteger(item.deliveryLimitChars) && item.deliveryLimitChars > 0
    && item.deliveryLimitChars <= item.envelopeLimitChars,
  'research_context_undelivered', 'The delivery lost its declared limits');
}

export function requireResearchDelivery(original: AddressedOriginal, key: string, delivery: unknown): asserts delivery is ResearchDelivery {
  requireDelivery(original, key, delivery, 'original');
}

/** The caller is the context-workspace adapter, whose originals are the
 * results of the shared exact context reader, not caller-provided authority. */
export function requireResearchContextDelivery(original: AddressedOriginal, key: string, delivery: unknown): asserts delivery is ResearchDelivery {
  requireDelivery(original, key, delivery,
    original.page?.encoding === 'canonical-json' ? 'context-page' : 'original');
}

/** Re-derive a transported archive fragment from the same pinned body used
 * when it was written. An address to some other record cannot lend its bytes. */
export function requirePacketMaterialDelivery(packet: Record<string, any>, archive: Ref,
  resolve: (record: Ref, pointer: string) => unknown): void {
  const addresses = packet.working?.materialAddresses;
  if (addresses === undefined && !Object.hasOwn(packet, 'materialDelivery')) return;
  requireCondition(isRef(packet.working?.archive)
    && canonical(packet.working.archive) === canonical(archive),
    'research_context_undelivered', 'The delivered material belongs to another packet archive');
  requireCondition(addresses === undefined || Array.isArray(addresses),
    'research_context_undelivered', 'The addressed material set is invalid');
  for (const address of addresses ?? [] as ResearchMaterialAddress[]) {
    requireCondition(address && isRef(address.record)
      && typeof address.field === 'string' && typeof address.pointer === 'string'
      && address.pointer.startsWith('/body/') && address.pointer === `/body/${address.field.replaceAll('~','~0').replaceAll('/','~1')}`,
    'research_context_undelivered', 'An omitted material address needs an exact saved body');
    const value = resolve(address.record, address.pointer);
    requireCondition(canonical(value) === canonical(resolve(archive, address.pointer)),
      'research_context_undelivered', 'The addressed original differs from this packet archive');
    const encoding = Array.isArray(value) ? 'array-items' : typeof value === 'string' ? 'utf16-string' : 'canonical-json';
    const total = encoding === 'canonical-json' ? canonical(value).length : (value as string | unknown[]).length;
    requireCondition(address.valueHash === hashJson(value) && address.encoding === encoding
      && address.unit === (encoding === 'array-items' ? 'items' : 'utf16') && address.total === total,
    'research_context_undelivered', 'An omitted material address differs from its saved original');
    requireCondition(!Object.hasOwn(packet, address.field), 'research_context_undelivered',
      'The omitted original was duplicated in full inside the packet');
  }
  if (!Object.hasOwn(packet, 'materialDelivery')) return;
  const entries = packet.materialDelivery;
  requireCondition(Array.isArray(entries) && entries.length === 1,
    'research_context_undelivered', 'The saved packet needs one exact material fragment');
  for (const entry of entries as ResearchDelivery[]) {
    requireCondition(entry?.contract === 'research-delivery/v1'
      && isRef(entry.original?.record)
      && typeof entry.original.pointer === 'string' && entry.original.pointer.startsWith('/body/'),
    'research_context_undelivered', 'The material fragment needs an exact archive');
    const value = resolve(entry.original.record, entry.original.pointer);
    const key = hashJson({ record: entry.original.record, pointer: entry.original.pointer, value });
    const fragmentPage = entry.original.page as AddressedOriginal['page'] | null;
    if (packet.consolidation?.deliveryContract === 'consolidation-fragment/v1')
      requireCondition(fragmentPage && typeof fragmentPage === 'object'
        && fragmentPage.encoding === 'canonical-json',
      'research_context_undelivered', 'The partial note needs an exact canonical JSON page');
    requireResearchDelivery({ record: entry.original.record, pointer: entry.original.pointer, value,
      ...(packet.consolidation?.deliveryContract === 'consolidation-fragment/v1'
        ? { page: fragmentPage! } : {}) }, key, entry);
    if (addresses?.length) requireCondition(addresses.some((address: ResearchMaterialAddress) =>
      address.pointer === entry.original.pointer && address.valueHash === entry.original.valueHash)
      || packet.dispatchMode === 'planning' && packet.working?.navigationAddresses?.some((address: {
        record: Ref; pointer: string; sourceHash: string }) => canonical(address.record) === canonical(entry.original.record)
          && address.pointer === entry.original.pointer && address.sourceHash === entry.original.valueHash),
    'research_context_undelivered', 'The partial material has no declared exact address');
  }
}

/** Replace only transport copies of large saved fields by exact addresses.
 * One positive fragment is chosen after the context workspace gets its space. */
export function addressArchivedMaterials(packet: Record<string, any>, archive: Ref,
  fields: string[], maxChars: number, stableRecord: (field: string, value: unknown) => Ref,
  reserveChars = 4096): AddressedOriginal[] {
  const originals: AddressedOriginal[] = [];
  const working = packet.working as Record<string, any> | undefined;
  requireCondition(working && canonical(working.archive) === canonical(archive),
    'research_context_invalid', 'Material addresses need the exact packet archive');
  for (const field of [...fields].sort((left, right) =>
    (packet[right] === undefined ? 0 : JSON.stringify(packet[right]).length)
      - (packet[left] === undefined ? 0 : JSON.stringify(packet[left]).length))) {
    if (!Object.hasOwn(packet, field)) continue;
    const value = packet[field];
    if (value === '' || Array.isArray(value) && value.length === 0) continue;
    if (JSON.stringify(value).length <= Math.floor(maxChars / 3)
      && JSON.stringify(packet).length <= maxChars - reserveChars) continue;
    const pointer = `/body/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    const encoding = Array.isArray(value) ? 'array-items' : typeof value === 'string' ? 'utf16-string' : 'canonical-json';
    const record = stableRecord(field, value);
    const original = { record, pointer, value };
    originals.push(original);
    working.materialAddresses = [...(working.materialAddresses ?? []), {
      field, record, pointer, valueHash: hashJson(value),
      total: encoding === 'canonical-json' ? canonical(value).length : (value as string | unknown[]).length,
      unit: encoding === 'array-items' ? 'items' : 'utf16', encoding } satisfies ResearchMaterialAddress];
    working.omitted = [...new Set([...(working.omitted ?? []), field])];
    delete packet[field];
  }
  if (originals.length) working.instruction +=
    ' materialAddresses names full immutable originals omitted from this transport. Read each exact record and pointer with read_context and continue at the delivered next offset; a fragment never proves the omitted remainder.';
  return originals;
}

export function serveArchivedMaterial(packet: Record<string, any>, originals: AddressedOriginal[],
  maxChars: number, reserveChars = 1024): void {
  if (!originals.length) return;
  const original = originals[0]!;
  const key = hashJson({ record: original.record, pointer: original.pointer, value: original.value });
  const available = maxChars - reserveChars - JSON.stringify(packet).length;
  const delivery = available > 0 ? planResearchDelivery(original, key, maxChars, available, candidate => {
    packet.materialDelivery = [candidate];
    return JSON.stringify(packet).length <= maxChars - reserveChars;
  }) : null;
  if (!delivery) throw new EngineError('pilot_core_limit',
    'No positive part of the saved original fits beside the required question and addresses',
    { pointer: original.pointer, required: JSON.stringify(packet).length,
      envelopeLimitChars: maxChars });
  packet.materialDelivery = [delivery];
}

/** Project one oversized saved collection into the available packet space.
 * The full field remains only in the immutable archive; the transport names
 * its exact address and carries a positive, explicitly incomplete page. */
export function packArchivedField(packet: Record<string, any>, archive: Ref, field: string,
  maxChars: number, reserveChars = 1024): void {
  if (!Object.hasOwn(packet, field) || JSON.stringify(packet).length <= maxChars - reserveChars) return;
  const value = packet[field];
  const pointer = `/body/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  packAddressedValue(packet, field, { record: archive, pointer, value }, maxChars, reserveChars);
}

/** The displayed field can be derived (for example a compact conclusion),
 * while the fragment always names a real saved source of those bytes. */
export function packAddressedValue(packet: Record<string, any>, field: string,
  original: AddressedOriginal, maxChars: number, reserveChars = 1024): void {
  const { record, pointer, value } = original;
  const key = hashJson({ record, pointer, value });
  delete packet[field];
  const working = packet.working as Record<string, any> | undefined;
  if (working) {
    working.omitted = [...new Set([...(working.omitted ?? []), field])];
    working.instruction += ' materialDelivery contains an exact partial saved original, never the complete field. Use requested/served/next and its original address to read the remainder; do not infer omitted content.';
  }
  const target = maxChars - reserveChars;
  const available = Math.max(0, target - JSON.stringify(packet).length);
  const delivery = available > 0 ? planResearchDelivery(original, key, maxChars, available, candidate => {
    packet.materialDelivery = [candidate];
    return JSON.stringify(packet).length <= target;
  }) : null;
  if (delivery) packet.materialDelivery = [delivery]; else delete packet.materialDelivery;
  if (!delivery) throw new EngineError('pilot_core_limit',
    'No positive part of the saved collection fits beside the mandatory question and grounds',
    { field, pointer, required: JSON.stringify(packet).length, envelopeLimitChars: maxChars });
}

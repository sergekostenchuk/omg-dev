import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write } from '../storage/store.js';
import { writeGuarded } from './refs.js';
import { isPlainObject, isText } from './refusal.js';
import { unfinishedRunCalls, runOwnerState } from './run-control.js';
import type { QuestionPacketRecord } from './question-packet.js';
import type { OmModelCall } from './model-call.js';

export const OM_CAPACITY_DELIVERY_CONTRACT = 'om-capacity-delivery/v1' as const;
export const OM_CAPACITY_RECOVERY_CONTRACT = 'om-capacity-recovery/v1' as const;
export const OM_CAPACITY_RECOVERY_KIND = 'om-capacity-recovery';
export const OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT = 'om-limited-call-retry-permit/v1' as const;
export const OM_LIMITED_CALL_RETRY_PERMIT_KIND = 'om-limited-call-retry-permit';

export const CAPACITY_REFUSAL_CODES = Object.freeze([
  'packet_too_large',
  'node_unexpandable',
  'context_budget_exceeded',
  'needs_owner',
] as const);

export interface OmCapacityDelivery {
  contract: typeof OM_CAPACITY_DELIVERY_CONTRACT;
  original: {
    record: Ref;
    pointer: string;
    valueHash: string;
    field?: string;
    packet?: Ref;
    call?: Ref;
    response?: Ref;
    delivery?: Ref;
  };
  requested: { offset: number; end: number; total: number; unit: 'items' | 'utf16' };
  served: { offset: number; end: number; total: number; next: number | null; unit: 'items' | 'utf16' };
  encoding: 'array-items' | 'utf16-string' | 'json-string-fragment';
  value?: unknown;
  text?: string;
  description?: string;
  envelopeLimitChars: number;
  deliveryLimitChars: number;
}

export interface AddressedOmOriginal {
  record: Ref;
  pointer: string;
  value: unknown;
  field?: string;
  packet?: Ref;
  call?: Ref;
  response?: Ref;
  delivery?: Ref;
  page?: { offset: number; end: number; total: number; unit: 'items' | 'utf16'; next: number | null };
}

export interface OmCapacityRecoveryRecord {
  contract: typeof OM_CAPACITY_RECOVERY_CONTRACT;
  project: string;
  blockedPacket: Ref;
  successorPacket: Ref;
  actor: string;
  recoveredAt: number;
}

export interface OmLimitedCallRetryPermit {
  contract: typeof OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT;
  project: string;
  call: Ref;
  callRecord?: Ref;
  terminal: Ref;
  actor: string;
  permittedAt: number;
}

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const sameRef = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision && a.hash === b.hash;

export function omCapacityRecoveryId(project: string, packet: Ref): string {
  return `${OM_CAPACITY_RECOVERY_KIND}:${project}:${hashJson(packet)}`;
}

export function omLimitedCallRetryPermitId(project: string, call: Ref): string {
  return `${OM_LIMITED_CALL_RETRY_PERMIT_KIND}:${project}:${hashJson(call)}`;
}

function requestBounds(original: AddressedOmOriginal): OmCapacityDelivery['requested'] {
  const unit: 'items' | 'utf16' = Array.isArray(original.value) && original.page?.unit !== 'utf16' ? 'items' : 'utf16';
  const total = Array.isArray(original.value) && unit === 'items'
    ? original.value.length
    : typeof original.value === 'string'
      ? original.value.length
      : canonical(original.value).length;
  if (!original.page) return { offset: 0, end: total, total, unit };
  const page = original.page;
  requireCondition((page.unit === 'items' || page.unit === 'utf16') && page.unit === unit
    && Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.end) && Number.isSafeInteger(page.total)
    && page.offset >= 0 && page.end >= page.offset && page.total === total && page.total >= page.end,
  'om_capacity_delivery_invalid', 'A delivered page needs exact bounds on its saved original');
  return { offset: page.offset, end: page.end, total: page.total, unit };
}

/** Pure arithmetic to fit the largest positive prefix into available wire space. */
export function planOmCapacityDelivery(
  original: AddressedOmOriginal,
  envelopeLimitChars: number,
  deliveryLimitChars: number,
  fits: (delivery: OmCapacityDelivery) => boolean
): OmCapacityDelivery | null {
  requireCondition(isRef(original.record) && typeof original.pointer === 'string',
    'om_capacity_delivery_invalid', 'An addressed delivery needs its original identity');
  requireCondition(Number.isSafeInteger(envelopeLimitChars) && envelopeLimitChars > 0
    && Number.isSafeInteger(deliveryLimitChars) && deliveryLimitChars > 0,
  'om_capacity_delivery_invalid', 'Declared envelope and delivery limits must be positive safe integers');

  const requested = requestBounds(original);
  const base = {
    contract: OM_CAPACITY_DELIVERY_CONTRACT,
    original: {
      record: original.record,
      pointer: original.pointer,
      valueHash: hashJson(original.value),
      ...(original.field ? { field: original.field } : {}),
      ...(original.packet ? { packet: original.packet } : {}),
      ...(original.call ? { call: original.call } : {}),
      ...(original.response ? { response: original.response } : {}),
      ...(original.delivery ? { delivery: original.delivery } : {}),
    },
    requested,
    envelopeLimitChars,
    deliveryLimitChars,
  };

  const isSliceable = typeof original.value === 'string' || Array.isArray(original.value) && requested.unit === 'items';
  if (isSliceable) {
    const start = requested.offset;
    const fragment = (count: number): OmCapacityDelivery => {
      const encoding: OmCapacityDelivery['encoding'] = Array.isArray(original.value)
        ? 'array-items'
        : 'utf16-string';
      const content = (original.value as string | unknown[]).slice(start, start + count);
      const offset = start;
      const total = requested.total;
      const end = offset + count;
      const next = end < total ? end : null;
      return {
        ...base,
        requested,
        served: {
          offset,
          end,
          total,
          next,
          unit: requested.unit,
        },
        encoding,
        value: content,
        description: `Fragment of ${original.pointer}: [${offset}..${end}) of ${total} ${requested.unit}`,
      };
    };

    let low = 0, high = requested.end - start;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(fragment(mid))) low = mid; else high = mid - 1;
    }
    if (low > 0) return fragment(low);
  }

  // A large array item must be read at its own exact pointer. A JSON cursor on the
  // enclosing array would include items outside the requested range.
  if (Array.isArray(original.value) && requested.unit === 'items'
    && (requested.offset !== 0 || requested.end !== requested.total) && requested.offset < requested.end) {
    const index = requested.offset;
    const { page: _page, ...child } = original;
    return planOmCapacityDelivery({ ...child, pointer: `${original.pointer}/${index}`,
      value: original.value[index] }, envelopeLimitChars, deliveryLimitChars, fits);
  }

  // JSON fallback for one exact non-sliceable value.
  const encoded = canonical(original.value);
  const jsonTotal = encoded.length;
  const jsonRequested: OmCapacityDelivery['requested'] = original.page?.unit === 'utf16'
    ? requested
    : { offset: 0, end: jsonTotal, total: jsonTotal, unit: 'utf16' };
  const jsonStart = jsonRequested.offset;
  const jsonFragment = (count: number): OmCapacityDelivery => {
    const content = encoded.slice(jsonStart, jsonStart + count);
    const offset = jsonStart;
    const total = jsonRequested.total;
    const end = offset + count;
    const next = end < total ? end : null;
    return {
      ...base,
      requested: jsonRequested,
      served: {
        offset,
        end,
        total,
        next,
        unit: 'utf16',
      },
      encoding: 'json-string-fragment',
      text: content,
      description: `Fragment of ${original.pointer}: [${offset}..${end}) of ${total} utf16`,
    };
  };

  let low = 0, high = jsonRequested.end - jsonStart;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(jsonFragment(mid))) low = mid; else high = mid - 1;
  }
  return low > 0 ? jsonFragment(low) : null;
}

/** Verify a saved delivery against its exact original. Same function used on write and replay. */
export function requireOmCapacityDelivery(
  original: AddressedOmOriginal,
  delivery: unknown
): asserts delivery is OmCapacityDelivery {
  requireCondition(object(delivery), 'om_capacity_delivery_invalid', 'The saved capacity delivery is missing');
  const item = delivery as unknown as OmCapacityDelivery;
  const requested = requestBounds(original);
  if (Array.isArray(original.value) && requested.unit === 'items' && requested.offset < requested.end
    && item.original?.pointer === `${original.pointer}/${requested.offset}`) {
    const { page: _page, ...child } = original;
    requireOmCapacityDelivery({ ...child, pointer: item.original.pointer,
      value: original.value[requested.offset] }, delivery);
    return;
  }
  const expectedOriginal = {
    record: original.record, pointer: original.pointer, valueHash: hashJson(original.value),
    ...(original.field ? { field: original.field } : {}),
    ...(original.packet ? { packet: original.packet } : {}),
    ...(original.call ? { call: original.call } : {}),
    ...(original.response ? { response: original.response } : {}),
    ...(original.delivery ? { delivery: original.delivery } : {}),
  };
  requireCondition(item.contract === OM_CAPACITY_DELIVERY_CONTRACT
    && isRef(item.original?.record) && same(item.original, expectedOriginal),
  'om_capacity_delivery_invalid', 'The delivery does not match its exact saved original');

  const served = item.served;
  if (item.encoding === 'json-string-fragment') {
    const encoded = canonical(original.value);
    const expectedRequested = original.page?.unit === 'utf16'
      ? requested
      : { offset: 0, end: encoded.length, total: encoded.length, unit: 'utf16' };
    const expectedSlice = encoded.slice(served?.offset ?? 0, served?.end ?? 0);
    requireCondition(same(item.requested, expectedRequested)
      && Number.isSafeInteger(served?.offset) && served.offset === expectedRequested.offset
      && Number.isSafeInteger(served.end) && served.end > served.offset
      && served.end <= expectedRequested.end && served.total === encoded.length && served.unit === 'utf16'
      && served.next === (served.end < encoded.length ? served.end : null)
      && typeof item.text === 'string' && item.text.length === (served.end - served.offset)
      && item.text === expectedSlice && !Object.hasOwn(item, 'value'),
    'om_capacity_delivery_invalid', 'The JSON fragment delivery differs from the saved original');
  } else {
    const localSlice = (original.value as string | unknown[]).slice(served?.offset ?? 0, served?.end ?? 0);
    requireCondition(same(item.requested, requested)
      && served?.offset === requested.offset && Number.isSafeInteger(served.end)
      && served.end > served.offset && served.end <= requested.end && served.total === requested.total
      && served.unit === requested.unit && served.next === (served.end < requested.total ? served.end : null)
      && item.encoding === (Array.isArray(original.value) ? 'array-items' : 'utf16-string')
      && (!Array.isArray(original.value) || requested.unit === 'items')
      && ((typeof item.value === 'string' || Array.isArray(item.value)) && item.value.length === (served.end - served.offset))
      && same(item.value, localSlice)
      && !Object.hasOwn(item, 'text'),
    'om_capacity_delivery_invalid', 'The delivered page differs from the saved original');
  }

  requireCondition(Number.isSafeInteger(item.envelopeLimitChars) && item.envelopeLimitChars > 0
    && Number.isSafeInteger(item.deliveryLimitChars) && item.deliveryLimitChars > 0
    && item.deliveryLimitChars <= item.envelopeLimitChars,
  'om_capacity_delivery_invalid', 'The delivery lost its declared limits');
}

/** Measures actual serialized adapter wire on stdin, including JSON escaping of prompt and metadata. */
export function measureAdapterWire(
  packet: unknown,
  requestId: string,
  model = 'codex-5.3',
  effort = 'high',
  speed?: 'fast' | 'inherited'
): number {
  const prompt = typeof packet === 'object' && packet !== null && typeof (packet as Record<string, unknown>).brief === 'object' && (packet as Record<string, unknown>).brief !== null && typeof ((packet as Record<string, unknown>).brief as Record<string, unknown>).text === 'string'
    ? ((packet as Record<string, unknown>).brief as Record<string, unknown>).text as string
    : canonical(packet);
  const envelope = {
    protocol: 'omg-agent/v1',
    requestId,
    mode: 'research',
    model,
    effort,
    ...(speed !== undefined ? { speed } : {}),
    prompt,
  };
  return canonical(envelope).length;
}

export function fitsWire(
  packet: unknown,
  requestId: string,
  maxRequestChars: number,
  model = 'codex-5.3',
  effort = 'high',
  speed?: 'fast' | 'inherited'
): boolean {
  return measureAdapterWire(packet, requestId, model, effort, speed) <= maxRequestChars;
}

/** Public command: recover-om-capacity { project, packet: Ref } */
export function recoverOmCapacity(
  store: Store,
  request: { project: string; packet: Ref },
  actor: string
): OmCapacityRecoveryRecord {
  requireCondition(store instanceof Store && object(request) && isText(request.project)
    && isRef(request.packet) && isText(actor),
  'capacity_recovery_invalid', 'Capacity recovery requires the project, exact packet ref and actor');

  const packetRecord = store.get<QuestionPacketRecord>(request.packet.id, request.packet.revision);
  requireCondition(packetRecord && packetRecord.kind === 'question-packet'
    && packetRecord.value.project === request.project && same(reference(packetRecord), request.packet),
  'capacity_recovery_invalid', 'The named packet is not a valid question packet of this project');

  requireCondition(packetRecord.value.state === 'blocked',
    'capacity_recovery_invalid', 'Only a blocked question packet can be recovered');

  const refusalCode = packetRecord.value.refusal?.code;
  requireCondition(typeof refusalCode === 'string' && (CAPACITY_REFUSAL_CODES as readonly string[]).includes(refusalCode),
    'capacity_recovery_unsupported', 'Only proved capacity/delivery refusals are recoverable through recover-om-capacity');

  const runRecord = store.get<{ state: { phase: string } }>(`om-run:${request.project}`);
  requireCondition(runRecord && runRecord.value.state.phase !== 'complete',
    'capacity_recovery_invalid', 'A completed pass has no blocked work to recover');

  const unfinished = unfinishedRunCalls(store, request.project);
  requireCondition(!unfinished.some(c => runOwnerState(c.value['ownerProcess'] as any) === 'alive'),
    'capacity_recovery_busy', 'Cannot recover capacity while a call is running');

  const recoveryId = omCapacityRecoveryId(request.project, request.packet);
  const existing = store.get<OmCapacityRecoveryRecord>(recoveryId);
  if (existing && existing.value.contract === OM_CAPACITY_RECOVERY_CONTRACT) {
    return existing.value;
  }

  // Derive the successor packet with capacity delivery enabled.
  // Dynamic import or circular-safe call to question-packet builder.
  const { deriveCapacitySuccessorPacket } = requireSuccessorDeriver();
  const successor = deriveCapacitySuccessorPacket(store, request.project, packetRecord, actor);

  if (successor.record.value.state === 'blocked') {
    throw new EngineError('needs_owner',
      successor.record.value.refusal?.message ?? 'The irreducible core of the assignment exceeds capacity: configure larger capacity or split the assignment',
      {
        unit: 'E2',
        target: request.packet.id,
        field: 'packet',
        assignment: packetRecord.value.request.batch,
        refusal: successor.record.value.refusal,
      }
    );
  }

  const recoveryRecord: OmCapacityRecoveryRecord = {
    contract: OM_CAPACITY_RECOVERY_CONTRACT,
    project: request.project,
    blockedPacket: request.packet,
    successorPacket: successor.reference,
    actor,
    recoveredAt: Date.now(),
  };

  const writes: Write[] = [
    ...successor.writes,
    {
      id: recoveryId,
      kind: OM_CAPACITY_RECOVERY_KIND,
      expected: 0,
      value: recoveryRecord as unknown as Json,
    },
  ];

  const guards: TransactionGuard[] = [
    request.packet,
    reference(runRecord),
    ...successor.guards,
  ];

  const writeRes = writeGuarded(store, { unit: 'E2', target: recoveryId, writes, guards });
  if (!writeRes.ok) {
    if (['revision_conflict', 'input_stale'].includes(writeRes.refusal.code)) {
      const concurrent = store.get<OmCapacityRecoveryRecord>(recoveryId);
      if (concurrent && concurrent.value.contract === OM_CAPACITY_RECOVERY_CONTRACT) {
        return concurrent.value;
      }
    }
    throw new EngineError(writeRes.refusal.code, writeRes.refusal.message, writeRes.refusal.at as any);
  }

  return recoveryRecord;
}

/** Read an existing capacity recovery record for a blocked packet if one exists. */
export function readOmCapacityRecovery(
  store: Store,
  project: string,
  packet: Ref
): OmCapacityRecoveryRecord | null {
  const id = omCapacityRecoveryId(project, packet);
  const row = store.get<OmCapacityRecoveryRecord>(id);
  return row && row.value.contract === OM_CAPACITY_RECOVERY_CONTRACT ? row.value : null;
}

/** Public command: permit-limited-call-retry { project, call: Ref } for OM process_output_limit calls */
export function permitOmLimitedCallRetry(
  store: Store,
  request: { project: string; call: Ref },
  actor: string
): OmLimitedCallRetryPermit {
  requireCondition(store instanceof Store && object(request) && isText(request.project)
    && isRef(request.call) && isText(actor),
  'limited_call_retry_invalid', 'The door needs the project, exact call and actor');

  const callRecord = store.get<OmModelCall>(request.call.id, request.call.revision);
  requireCondition(callRecord && callRecord.kind === 'model-call'
    && callRecord.value.projectId === request.project && same(reference(callRecord), request.call),
  'limited_call_retry_stale', 'The named call is not the current terminal of this project');

  // Verify that the call is in failed status due to process_output_limit
  const hasOutputLimit = callRecord.value.status === 'failed' && (
    callRecord.value.error === 'process_output_limit'
    || callRecord.value.om?.failure?.code === 'process_output_limit'
    || (isRef(callRecord.value.om?.exchange) && (store.get(callRecord.value.om.exchange.id)?.value as { launchError?: { code: string } } | undefined)?.launchError?.code === 'process_output_limit')
  );
  requireCondition(hasOutputLimit, 'limited_call_retry_invalid',
    `[${request.call.id}] The exact paid operation does not prove an output-limit failure`);

  // Verify that there is an OM owner/assignment/attempt
  requireCondition(callRecord.value.om?.admission !== undefined || callRecord.value.om?.completionOwner !== undefined,
    'limited_call_retry_invalid', `[${request.call.id}] Call must belong to an OM assignment or attempt`);

  const runRecord = store.get<{ state: { phase: string } }>(`om-run:${request.project}`);
  requireCondition(runRecord && runRecord.value.state.phase !== 'complete',
    'limited_call_retry_invalid', 'A completed pass has no failed call to retry');

  const unfinished = unfinishedRunCalls(store, request.project);
  requireCondition(!unfinished.some(c => runOwnerState(c.value['ownerProcess'] as any) === 'alive'),
    'limited_call_retry_busy', `[${request.call.id}] This question already has an active physical claim`);

  const permitId = omLimitedCallRetryPermitId(request.project, request.call);
  const existing = store.get<OmLimitedCallRetryPermit>(permitId);
  if (existing && existing.value.contract === OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT) {
    return existing.value;
  }

  const e1Call = (callRecord.value.om?.call as Ref | undefined) ?? request.call;
  const permitRecord: OmLimitedCallRetryPermit = {
    contract: OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT,
    project: request.project,
    call: request.call,
    callRecord: e1Call,
    terminal: request.call,
    actor,
    permittedAt: Date.now(),
  };

  const writeRes = writeGuarded(store, {
    unit: 'E4',
    target: permitId,
    writes: [{
      id: permitId,
      kind: OM_LIMITED_CALL_RETRY_PERMIT_KIND,
      expected: 0,
      value: permitRecord as unknown as Json,
    }],
    guards: [request.call, reference(runRecord)],
  });
  if (!writeRes.ok) {
    if (['revision_conflict', 'input_stale'].includes(writeRes.refusal.code)) {
      const concurrent = store.get<OmLimitedCallRetryPermit>(permitId);
      if (concurrent && concurrent.value.contract === OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT) {
        return concurrent.value;
      }
    }
    throw new EngineError(writeRes.refusal.code, writeRes.refusal.message, writeRes.refusal.at as any);
  }

  return permitRecord;
}

export function readOmLimitedCallRetryPermit(
  store: Store,
  project: string,
  call: Ref
): OmLimitedCallRetryPermit | null {
  const id = omLimitedCallRetryPermitId(project, call);
  const row = store.get<OmLimitedCallRetryPermit>(id);
  if (row && row.value.contract === OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT) {
    return row.value;
  }
  for (const permit of store.list<OmLimitedCallRetryPermit>(OM_LIMITED_CALL_RETRY_PERMIT_KIND)) {
    if (permit.value.contract === OM_LIMITED_CALL_RETRY_PERMIT_CONTRACT && permit.value.project === project) {
      if (sameRef(permit.value.call, call) || (isRef(permit.value.callRecord) && sameRef(permit.value.callRecord, call))) {
        return permit.value;
      }
      const physical = store.get<OmModelCall>(permit.value.call.id, permit.value.call.revision);
      if (physical && isRef(physical.value?.om?.call) && sameRef(physical.value.om.call, call)) {
        return permit.value;
      }
    }
  }
  return null;
}

let successorDeriver: {
  deriveCapacitySuccessorPacket: (
    store: Store,
    project: string,
    blockedPacket: Revision<QuestionPacketRecord>,
    actor: string
  ) => { reference: Ref; writes: Write[]; guards: TransactionGuard[]; record: Revision<QuestionPacketRecord> };
} | null = null;

export function registerSuccessorDeriver(deriver: typeof successorDeriver): void {
  successorDeriver = deriver;
}

function requireSuccessorDeriver() {
  requireCondition(successorDeriver !== null, 'capacity_recovery_invalid',
    'Successor deriver has not been registered');
  return successorDeriver;
}

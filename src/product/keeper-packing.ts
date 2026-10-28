import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { readEnvironmentAt, type Environment, type RoleBinding } from '../runtime/environment.js';
import type { Revision, Store, TransactionGuard, Write } from '../storage/store.js';
import { partitionJsonObject, prepareStoreParts, restoreTextFromParts } from '../discovery/request-parts.js';
import { planResearchContextDelivery, requireResearchContextDelivery, type ResearchDelivery } from '../discovery/research-delivery.js';
import { prepareResearchEnvelope } from '../discovery/research-protocol.js';
import type { KeeperRequest } from './keeper-request.js';

export const KEEPER_ARCHIVE = 'keeper-archive/v1' as const;
export const KEEPER_PACKING = 'keeper-packing/v1' as const;
export interface KeeperPackingInput {
  environment: Ref; prompt: string; packetChars: number; limitChars: number; resultLimitChars: number;
}
export interface KeeperArchive {
  contract: typeof KEEPER_ARCHIVE; project: string; parts: Ref[];
  sha256: string; chars: number; bytes: number;
}
export interface KeeperEnvelope {
  packet: { contract: typeof KEEPER_PACKING; key: KeeperRequest['key']; schema: Json;
    instruction: string; replyLimitChars: number; delivery: ResearchDelivery };
  input: string; measuredChars: number;
}
export interface KeeperPacking {
  contract: typeof KEEPER_PACKING; archive: Ref; parts: Ref[]; role: RoleBinding;
  envelopes: KeeperEnvelope[];
}
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function valid(value: unknown, message: string): asserts value {
  requireCondition(value, 'keeper_session_invalid', message);
}
export function keys(value: unknown, fields: readonly string[]): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), [...fields].sort());
}
export const exactRef = (value: unknown): value is Ref => keys(value, ['id', 'revision', 'hash']) && isRef(value);
export function snapshot<T>(value: T): T {
  try { return JSON.parse(canonical(value)); }
  catch { throw new EngineError('keeper_session_invalid', 'Expected one finite plain JSON snapshot'); }
}
export function decodeKeeperPackingInput(value: unknown): KeeperPackingInput {
  valid(keys(value, ['environment', 'prompt', 'packetChars', 'limitChars', 'resultLimitChars']), 'Expected the closed physical preparation input');
  valid(exactRef(value.environment) && typeof value.prompt === 'string' && !!value.prompt.trim(), 'Expected exact Environment and instruction');
  for (const field of ['packetChars', 'limitChars', 'resultLimitChars'])
    valid(Number.isSafeInteger(value[field]) && value[field] > 0, 'Physical request and reply bounds must be positive safe integers');
  valid(value.packetChars < value.limitChars, 'The packet must leave room for the common physical envelope');
  return structuredClone(value) as KeeperPackingInput;
}
const archiveId = (value: KeeperArchive) => `keeper-archive:${value.project}:${hashJson(value as unknown as Json)}`;
function limit(): never {
  throw new EngineError('keeper_request_limit', 'No positive fragment fits beside the complete Keeper key, schema, instruction and physical overhead');
}

/** Common request parts own the complete canonical request. A Keeper archive has its own binding rather than
 * pretending that a block/stage is a research draft or Question. This function stages all missing records only. */
export function stageKeeperPacking(store: Store, project: string, request: KeeperRequest, input: KeeperPackingInput): {
  packing: KeeperPacking; environment: Revision<Environment>; archive: KeeperArchive;
  writes: Write[]; guards: TransactionGuard[];
} {
  const environment = readEnvironmentAt(store, project, input.environment);
  const role = environment.value.reviewer;
  valid(role.actor !== environment.value.implementer.actor, 'Keeper must use the independent reviewer of the saved Environment');
  const full = canonical(request), body = { request };
  const staged = prepareStoreParts(store, project, partitionJsonObject(body));
  const archive: KeeperArchive = { contract: KEEPER_ARCHIVE, project, parts: staged.partRefs,
    sha256: staged.sha256, chars: staged.chars, bytes: staged.bytes };
  const id = archiveId(archive), existing = store.get(id);
  valid(!existing || existing.kind === 'keeper-archive' && existing.revision === 1
    && existing.hash === hashJson(existing.value) && same(existing.value, archive), 'The deterministic archive address contains incompatible material');
  const archiveRef = existing ? reference(existing) : { id, revision: 1, hash: hashJson(archive as unknown as Json) };
  const writes: Write[] = [...staged.writes];
  const guards: TransactionGuard[] = [...staged.guards];
  if (existing) guards.push(reference(existing));
  else writes.push({ id, kind: 'keeper-archive', expected: 0, value: archive as unknown as Json });
  const envelopes: KeeperEnvelope[] = [];
  // planResearchContextDelivery owns fragmentation and exact continuation arithmetic. Every fit is measured with the
  // common physical envelope, including schema, instruction, key and service fields; no sender lives here.
  for (let offset = 0; offset < full.length;) {
    const original = { record: archiveRef, pointer: '/body/request', value: full.slice(offset),
      page: { offset, end: full.length, total: full.length, unit: 'utf16', next: null, encoding: 'canonical-json' as const } };
    const key = hashJson({ record: archiveRef, pointer: original.pointer, requestId: request.requestId });
    const packetFor = (delivery: ResearchDelivery): KeeperEnvelope['packet'] => ({ contract: KEEPER_PACKING,
      key: structuredClone(request.key), schema: structuredClone(request.responseSchema),
      instruction: request.instruction, replyLimitChars: input.resultLimitChars, delivery });
    const wireFor = (packet: KeeperEnvelope['packet']) => prepareResearchEnvelope(role, environment.value,
      input.prompt, packet, undefined, undefined, undefined, undefined, input.limitChars);
    const delivery = planResearchContextDelivery(original, key, input.limitChars, input.packetChars, candidate => {
      const packet = packetFor(candidate);
      if (JSON.stringify(packet).length > input.packetChars) return false;
      try { return wireFor(packet).input.length <= input.limitChars; }
      catch (error) { if (error instanceof EngineError && error.code === 'pilot_request_limit') return false; throw error; }
    });
    if (!delivery || delivery.served.end <= offset) limit();
    requireResearchContextDelivery(original, key, delivery);
    const packet = packetFor(delivery), wire = wireFor(packet);
    if (wire.input.length > input.limitChars) limit();
    envelopes.push({ packet, input: wire.input, measuredChars: wire.input.length });
    offset = delivery.served.end;
  }
  return { packing: { contract: KEEPER_PACKING, archive: structuredClone(archiveRef),
    parts: structuredClone(staged.partRefs), role: structuredClone(role), envelopes },
  environment, archive, writes, guards };
}

/** Historical archive restoration checks every exact common part, including bytes and complete-body hash. */
export function readKeeperArchive(store: Store, project: string, rawRef: unknown, request: KeeperRequest): KeeperArchive {
  const at = snapshot(rawRef);
  valid(exactRef(at), 'Expected an exact archive address');
  const row = store.get<KeeperArchive>(at.id, at.revision);
  valid(row && row.kind === 'keeper-archive' && row.revision === 1 && same(reference(row), at)
    && hashJson(row.value as unknown as Json) === at.hash
    && keys(row.value, ['contract', 'project', 'parts', 'sha256', 'chars', 'bytes'])
    && row.value.contract === KEEPER_ARCHIVE && row.value.project === project && archiveId(row.value) === at.id
    && Array.isArray(row.value.parts) && row.value.parts.every(exactRef), 'The exact Keeper archive is missing, foreign or malformed');
  const restored = restoreTextFromParts({ store, projectId: project, parts: row.value.parts,
    expectedSha256: row.value.sha256, expectedChars: row.value.chars, expectedBytes: row.value.bytes,
    errorCode: 'keeper_session_invalid' });
  valid(restored.text === canonical({ request }), 'The archive does not retain the complete proven Keeper request');
  return structuredClone(row.value);
}

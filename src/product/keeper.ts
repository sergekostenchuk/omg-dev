import { hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';

/** DR9 9.1-F (codex-omg №9189, №9463): the closed form and the pure key of one
 * keeper check (карта, ndisc.k.n2) — the exact accepted artifact × the exact
 * constitution × the explicitly declared check version, in one project. An
 * address is the exact Ref of the container record and a canonical JSON
 * Pointer into its value; the empty pointer is the whole record. The
 * constitution of D7 lives inside its bundle, so its address is the bundle
 * container and the pointer to it — never an invented Ref or a hash of its
 * text; the Ref of the manifest proves acceptance later and does not stand for
 * this address. The key is computed from these bytes only: no current, latest
 * or default, no head read. Structural only: no accepted, supported or paid
 * mark, no permission to reuse a result, no producer, payment or block — the
 * paid producer and the exact pair proof are 9.2/9.3, behaviour 9.4/9.5. */
export const KEEPER_CHECK_KEY_KIND = 'keeper-check-key' as const;
export const KEEPER_CHECK_KEY_CONTRACT = 'keeper-check-key/v1' as const;
/** Words that name a moving target instead of a declared check version. */
const MOVING_VERSIONS = Object.freeze(['current', 'latest', 'default']);
/** A canonical JSON Pointer (RFC 6901): empty, or /-separated segments where ~ is only ~0 or ~1. */
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

export interface KeeperAddress { container: Ref; pointer: string }
export interface KeeperCheckKey {
  contract: typeof KEEPER_CHECK_KEY_CONTRACT; projectId: string;
  artifact: KeeperAddress; constitution: KeeperAddress; checkVersion: string;
}

function invalid(field: string, message: string): never {
  throw new EngineError('keeper_key_invalid', `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as an accepted mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed keeper key form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the keeper key form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function address(value: unknown, at: string): asserts value is KeeperAddress {
  shape(value, ['container', 'pointer'], at);
  shape(value.container, ['id', 'revision', 'hash'], `${at}.container`);
  if (!isRef(value.container)) invalid(`${at}.container`, 'Expected the exact reference of the container record');
  if (typeof value.pointer !== 'string' || !POINTER.test(value.pointer))
    invalid(`${at}.pointer`, 'Expected a canonical JSON Pointer; the empty pointer is the whole record');
}

/** The closed form of a keeper check key; the input is never mutated — the result is a copy. */
export function decodeKeeperCheckKey(value: unknown): KeeperCheckKey {
  if (!object(value) || value.contract !== KEEPER_CHECK_KEY_CONTRACT)
    invalid('contract', `Only ${KEEPER_CHECK_KEY_CONTRACT} is a known keeper key form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'artifact', 'constitution', 'checkVersion'], 'key');
  text(value.projectId, 'projectId');
  address(value.artifact, 'artifact');
  address(value.constitution, 'constitution');
  text(value.checkVersion, 'checkVersion');
  if (MOVING_VERSIONS.includes(value.checkVersion.trim().toLowerCase()))
    invalid('checkVersion', 'A check version is declared explicitly, never a moving current, latest or default');
  return structuredClone(value) as unknown as KeeperCheckKey;
}

/** The pure key: the same content gives the same key whatever its JSON key order;
 * another exact revision, hash, container or pointer of either address, another
 * project or another declared check version gives another key. */
export function keeperCheckKey(value: unknown): string {
  const decoded = decodeKeeperCheckKey(value);
  return `${KEEPER_CHECK_KEY_KIND}:${decoded.projectId}:${hashJson(decoded as unknown as Json)}`;
}

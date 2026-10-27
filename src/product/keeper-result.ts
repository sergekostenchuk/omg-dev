import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import { decodeKeeperCheckKey, keeperCheckKey, type KeeperCheckKey } from './keeper.js';

/** The result is a structural form over a supplied exact pair, not a proof that
 * either record was accepted or that a check was paid. A future consumer must
 * prove those origins and its authority to reuse the check. This module does no
 * Store reads or writes, payment, stage transition, or actual blocking. */
export const KEEPER_RESULT_CONTRACT = 'keeper-result/v1' as const;

export interface KeeperMaterial { ref: Ref; value: Json }
export interface KeeperRecommendation {
  kind: 'recommendation'; description: string;
  constitutionPointer: string | null; artifactPointer: string | null;
}
export interface KeeperViolation {
  kind: 'violation'; description: string;
  constitutionPointer: string; artifactPointer: string;
}
export type KeeperRemark = KeeperRecommendation | KeeperViolation;
export interface KeeperResult {
  contract: typeof KEEPER_RESULT_CONTRACT; key: KeeperCheckKey;
  outcome: 'conforms' | 'reject'; reason: string | null; remarks: KeeperRemark[];
}
export interface KeeperResultInput {
  key: KeeperCheckKey; artifact: KeeperMaterial; constitution: KeeperMaterial; result: KeeperResult;
}
export interface KeeperResultProjection extends KeeperResultInput { checkId: string; resultId: string }

function invalid(field: string, reason: string): never {
  throw new EngineError('keeper_result_invalid', `[${field}] ${reason}`, { field, reason });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed keeper result form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;

/** Resolve only own JSON properties; array indices have the RFC 6901 form.
 * Pointers in remarks are relative to the address selected by the key, so a
 * reference cannot escape to another part of the full container. */
function resolve(root: Json, pointer: unknown, at: string): Json {
  if (typeof pointer !== 'string' || !pointerPattern.test(pointer))
    invalid(at, 'Expected an RFC 6901 JSON Pointer');
  let value: Json = root;
  if (pointer === '') return value;
  for (const encoded of pointer.slice(1).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part)) invalid(at, 'Expected a canonical array index');
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index >= value.length || !Object.hasOwn(value, index))
        invalid(at, 'The array item does not exist');
      value = value[index]!;
    } else if (object(value)) {
      if (!Object.hasOwn(value, part)) invalid(at, 'The property does not exist');
      value = value[part] as Json;
    } else invalid(at, 'The pointer traverses a scalar');
  }
  return value;
}

function material(value: unknown, expected: Ref, at: string): KeeperMaterial {
  shape(value, ['ref', 'value'], at);
  shape(value.ref, ['id', 'revision', 'hash'], `${at}.ref`);
  if (!isRef(value.ref) || canonical(value.ref) !== canonical(expected))
    invalid(`${at}.ref`, 'The complete material must belong to the exact container in the key');
  if (hashJson(value.value) !== expected.hash)
    invalid(`${at}.value`, 'The full container material does not match its exact hash');
  return value as unknown as KeeperMaterial;
}
function decodedKey(value: unknown, at: string): KeeperCheckKey {
  try { return decodeKeeperCheckKey(value); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'keeper_key_invalid')
      invalid(at, `The exact keeper key is invalid: ${error.message}`);
    throw error;
  }
}

/** Decode one immutable JSON snapshot of the input. The two supplied values
 * are complete containers, not just the selected subtrees. `key` is the exact
 * structural pair, and `result.key` must identify that same pair and version.
 * A violation names an existing textual constitution item, an existing place
 * in the selected artifact, and the described result; recommendations are
 * retained without being upgraded to violations. The meaning is not judged. */
export function decodeKeeperResult(input: unknown): KeeperResultInput {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonical(input)) as unknown; }
  catch { invalid('input', 'Expected one complete JSON snapshot'); }
  shape(snapshot, ['key', 'artifact', 'constitution', 'result'], 'input');
  const key = decodedKey(snapshot.key, 'key');
  const artifact = material(snapshot.artifact, key.artifact.container, 'artifact');
  const constitution = material(snapshot.constitution, key.constitution.container, 'constitution');
  const artifactRoot = resolve(artifact.value, key.artifact.pointer, 'key.artifact.pointer');
  const constitutionRoot = resolve(constitution.value, key.constitution.pointer, 'key.constitution.pointer');
  if (!object(constitutionRoot)) invalid('key.constitution.pointer', 'The selected constitution must be an object');

  shape(snapshot.result, ['contract', 'key', 'outcome', 'reason', 'remarks'], 'result');
  const result = snapshot.result;
  if (result.contract !== KEEPER_RESULT_CONTRACT) invalid('result.contract', 'Unknown keeper result contract');
  const answerKey = decodedKey(result.key, 'result.key');
  if (canonical(answerKey) !== canonical(key)) invalid('result.key', 'The result belongs to another exact pair or check version');
  if (result.outcome !== 'conforms' && result.outcome !== 'reject') invalid('result.outcome', 'Expected conforms or reject');
  if (result.reason !== null) text(result.reason, 'result.reason');
  if (!Array.isArray(result.remarks)) invalid('result.remarks', 'Expected the complete list of remarks');
  let violations = 0;
  for (const [index, remark] of result.remarks.entries()) {
    const at = `result.remarks.${index}`;
    shape(remark, ['kind', 'description', 'constitutionPointer', 'artifactPointer'], at);
    if (remark.kind !== 'recommendation' && remark.kind !== 'violation') invalid(`${at}.kind`, 'Unknown remark kind');
    text(remark.description, `${at}.description`);
    if (remark.kind === 'violation') violations++;
    if (remark.constitutionPointer !== null || remark.kind === 'violation') {
      const item = resolve(constitutionRoot, remark.constitutionPointer, `${at}.constitutionPointer`);
      if (typeof item !== 'string' || !item.trim()) invalid(`${at}.constitutionPointer`, 'The pointer must name an existing constitution item');
    }
    if (remark.artifactPointer !== null || remark.kind === 'violation')
      resolve(artifactRoot, remark.artifactPointer, `${at}.artifactPointer`);
  }
  if (result.outcome === 'reject' && violations === 0) invalid('result.remarks', 'A rejection requires a fully linked violation');
  if (result.outcome === 'conforms' && violations !== 0) invalid('result.remarks', 'A conforming result cannot contain a violation');
  return { key, artifact, constitution, result: result as unknown as KeeperResult };
}

/** Deterministic structural identity and a copied projection; neither identity
 * is an accepted act, paid receipt, or authorization to reuse a result. */
export function projectKeeperResult(input: unknown): KeeperResultProjection {
  const decoded = decodeKeeperResult(input);
  const checkId = keeperCheckKey(decoded.key);
  const resultId = `keeper-result:${decoded.key.projectId}:${hashJson({ key: decoded.key, result: decoded.result })}`;
  return { ...decoded, checkId, resultId };
}

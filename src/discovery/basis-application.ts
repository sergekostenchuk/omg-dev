import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';

export const BASIS_APPLICATION_CONTRACT = 'basis-application/v1' as const;
export interface BasisAddress { record: Ref; pointer: string }
export interface BasisCatalogueEntry { address: BasisAddress; value: Json }
export interface BasisApplication {
  contract: typeof BASIS_APPLICATION_CONTRACT;
  basis: BasisAddress;
  appliedAt: string[];
}
export interface BasisApplicationOwner {
  /** Pointer into the whole answer value; the consumer supplies its schema's substantive fields. */
  pointer: string;
  fields: readonly string[];
  required: readonly BasisAddress[];
}
export interface BasisApplicationRequest {
  field: string;
  value: unknown;
  catalogue: readonly BasisCatalogueEntry[];
  owners: readonly BasisApplicationOwner[];
  /** Stage-wide coverage is a union; an owner's inherited obligations remain local. */
  required: readonly BasisAddress[];
}
export interface ResolvedBasisApplication {
  owner: string;
  application: BasisApplication;
  basis: BasisCatalogueEntry;
  targets: { pointer: string; value: Json }[];
}
export const BASIS_APPLICATION_CODES = Object.freeze([
  'basis_application_invalid', 'basis_application_missing', 'basis_application_material_invalid',
] as const);
type Code = typeof BASIS_APPLICATION_CODES[number];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const reserved = new Set(['applications', 'id', 'basis']);
const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');

/** No Store, heads or prompts: a catalogue is supplied by the exact-chain reader, never by the model. */
export function resolveBasisApplications(request: BasisApplicationRequest): ResolvedBasisApplication[] {
  const field = typeof request?.field === 'string' && request.field.length ? request.field : 'applications';
  const fail = (code: Code, pointer: string, message: string): never => {
    throw new EngineError(code, message, { field, pointer });
  };
  const material = 'basis_application_material_invalid', invalid = 'basis_application_invalid';
  const parts = (pointer: unknown, code: Code, at: string): string[] => {
    if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/')) || /~(?:[^01]|$)/.test(pointer))
      return fail(code, at, 'A JSON Pointer needs an absolute path and valid ~0/~1 escapes');
    return pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  };
  const json = (value: unknown, code: Code, at: string): Json => {
    try { return JSON.parse(canonical(value)) as Json; }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return fail(code, at, 'The supplied value must be explicit JSON');
    }
  };
  const addressKey = (address: unknown, code: Code, at: string): string => {
    if (!object(address) || !keys(address, ['record', 'pointer']) || !object(address.record)
      || !keys(address.record, ['id', 'revision', 'hash']) || !isRef(address.record))
      return fail(code, at, 'An application needs an exact record Ref and pointer');
    parts(address.pointer, code, at);
    return canonical(address);
  };
  const at = (value: Json, path: readonly string[], pointer: string): Json => {
    let result: Json = value;
    for (const token of path) {
      if (result === null || typeof result !== 'object' || !Object.hasOwn(result, token)
        || Array.isArray(result) && (!/^(0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token)) || Number(token) >= result.length))
        return fail(invalid, pointer, 'The application target does not exist in the proposed answer');
      result = (result as Record<string, Json>)[token]!;
    }
    return result;
  };
  if (!request || typeof request.field !== 'string' || !request.field.length || !Array.isArray(request.catalogue)
    || !Array.isArray(request.owners) || !Array.isArray(request.required))
    return fail(material, '', 'The field, allowed catalogue, owners and required coverage must be explicit');
  const catalogue = new Map<string, BasisCatalogueEntry>();
  for (const [index, entry] of request.catalogue.entries()) {
    const pointer = `/catalogue/${index}`;
    if (!object(entry) || !keys(entry, ['address', 'value'])) return fail(material, pointer, 'Catalogue entries need an address and value');
    const key = addressKey(entry.address, material, `${pointer}/address`);
    if (catalogue.has(key)) return fail(material, pointer, 'An allowed address must have one catalogue entry');
    catalogue.set(key, { address: structuredClone(entry.address) as BasisAddress, value: json(entry.value, material, `${pointer}/value`) });
  }
  const requiredKeys = (addresses: unknown, pointer: string): string[] => {
    if (!Array.isArray(addresses)) return fail(material, pointer, 'Required coverage is explicit, including an empty list');
    return addresses.map((address, index) => {
      const key = addressKey(address, material, `${pointer}/${index}`);
      if (!catalogue.has(key)) return fail(material, `${pointer}/${index}`, 'A required basis is missing from the delivered catalogue');
      return key;
    });
  };
  const complete = (required: readonly string[], covered: ReadonlySet<string>, pointer: string) => {
    for (const key of required) if (!covered.has(key))
      fail('basis_application_missing', pointer, `The proposal has no substantive application for ${key}`);
  };
  const required = requiredKeys(request.required, '/required'), value = json(request.value, invalid, '');
  const result: ResolvedBasisApplication[] = [], covered = new Set<string>(), owners = new Set<string>();
  for (const [index, owner] of request.owners.entries()) {
    const location = `/owners/${index}`;
    if (!object(owner) || !Array.isArray(owner.fields) || owner.fields.some(name => typeof name !== 'string' || !name || reserved.has(name)))
      return fail(material, location, 'The consumer must name substantive fields, excluding application metadata');
    const path = parts(owner.pointer, material, `${location}/pointer`);
    const ownerPointer = owner.pointer as string, fields = owner.fields as string[];
    if (owners.has(ownerPointer)) return fail(material, location, 'An application owner must be declared once');
    owners.add(ownerPointer);
    const localRequired = requiredKeys(owner.required, `${location}/required`);
    const subject = at(value, path, ownerPointer), applicationsPointer = `${ownerPointer}/applications`;
    if (!object(subject) || !Object.hasOwn(subject, 'applications') || !Array.isArray(subject.applications))
      return fail(invalid, applicationsPointer, 'Each owner must declare its applications array');
    const localCovered = new Set<string>();
    for (const [i, application] of subject.applications.entries()) {
      const pointer = `${applicationsPointer}/${i}`;
      if (!object(application) || !keys(application, ['contract', 'basis', 'appliedAt'])
        || application.contract !== BASIS_APPLICATION_CONTRACT || !Array.isArray(application.appliedAt) || !application.appliedAt.length)
        return fail(invalid, pointer, 'An application needs its contract, exact basis and nonempty appliedAt');
      const key = addressKey(application.basis, invalid, `${pointer}/basis`), basis = catalogue.get(key);
      if (!basis) return fail(invalid, `${pointer}/basis`, 'The proposed basis is not in the delivered catalogue');
      const targets = application.appliedAt.map((target: unknown) => {
        const selected = parts(target, invalid, `${pointer}/appliedAt`), relative = selected.slice(path.length);
        if (!path.every((token, n) => selected[n] === token) || !relative.length
          || !fields.includes(relative[0]!) || relative.some(token => reserved.has(token)))
          return fail(invalid, typeof target === 'string' ? target : `${pointer}/appliedAt`,
            'An application must address a substantive field of its own requirement or contract');
        const targetPointer = `/${selected.map(escape).join('/')}`;
        return { pointer: targetPointer, value: at(value, selected, targetPointer) };
      });
      localCovered.add(key); covered.add(key);
      result.push({ owner: ownerPointer, application: application as unknown as BasisApplication, basis, targets });
    }
    complete(localRequired, localCovered, applicationsPointer);
  }
  complete(required, covered, '');
  return structuredClone(result);
}

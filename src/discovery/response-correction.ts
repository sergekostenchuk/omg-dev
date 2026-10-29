import { canonical } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';

/** Each role keeps its own intent/application and paid-response proof. These
 * callbacks are product readers, never data supplied by the command. */
export interface ResponseCorrectionReader<T> {
  read(ref: Ref): Revision<T>;
  latest(root: Revision<T>): Revision<T>;
  previous(value: T): Ref | null;
  follows(previous: T, next: T): boolean;
  formFailure(record: Revision<T>): EngineError | null;
  responseFreeFailure(record: Revision<T>): boolean;
}

/** A correction buys one content attempt. Only proved response-free transport
 * successors can extend it; an invalid correcting answer cannot become a new
 * root. Capture this result once at entry, before executing the selected role. */
export function readResponseCorrectionChain<T>(rootRef: Ref, reader: ResponseCorrectionReader<T>,
  codes = { invalid: 'research_response_retry_invalid', stale: 'research_response_retry_stale' }) {
  requireCondition(isRef(rootRef), codes.invalid, 'A response correction needs its exact original refusal');
  const root = reader.read(rootRef);
  requireCondition(canonical(reference(root)) === canonical(rootRef), codes.invalid,
    'The correction reader must retain the exact refusal revision');
  const failure = reader.formFailure(root);
  requireCondition(failure, codes.invalid, 'Correction requires a proven paid response form refusal');
  const ancestors = new Set([root.id]);
  for (let child = root; reader.previous(child.value);) {
    const parentRef = reader.previous(child.value)!;
    requireCondition(isRef(parentRef) && !ancestors.has(parentRef.id), codes.stale,
      'The correction root has a cyclic or malformed predecessor chain');
    const parent = reader.read(parentRef);
    requireCondition(canonical(reference(parent)) === canonical(parentRef)
      && reader.follows(parent.value, child.value), codes.stale,
      'The correction root lost its original role and logical position');
    requireCondition(!reader.formFailure(parent), codes.invalid,
      'A correcting form refusal cannot open a second content correction');
    ancestors.add(parent.id);
    child = parent;
  }
  const latest = reader.latest(root), chain = [latest];
  const successors = new Set([latest.id]);
  for (let child = latest; child.id !== root.id;) {
    const parentRef = reader.previous(child.value);
    requireCondition(isRef(parentRef) && !successors.has(parentRef.id), codes.stale,
      'The selected refusal has a different or cyclic correction chain');
    const parent = reader.read(parentRef);
    requireCondition(canonical(reference(parent)) === canonical(parentRef)
      && reader.follows(parent.value, child.value)
      && (parent.id === root.id ? canonical(parentRef) === canonical(rootRef)
        : reader.responseFreeFailure(parent)), codes.stale,
      'Only a proven response-free provider failure can extend this correction');
    successors.add(parent.id);
    chain.unshift(parent);
    child = parent;
  }
  // A later revision of the root is not an alternative starting point.
  requireCondition(canonical(reference(chain[0]!)) === canonical(rootRef), codes.stale,
    'The correction chain does not start at the exact selected refusal');
  const retry = latest.id === root.id || reader.responseFreeFailure(latest) ? reference(latest) : null;
  return { root, latest, chain, retry, failure };
}

import { prepareCandidate, readCandidate, writeCandidate, type CandidateRequest, type CandidateReadRequest,
  type CandidateResult, type PreparedCandidate, type CandidateWriteResult, type FrameCandidateRecord } from './frame-candidate.js';
import type { Store, Revision } from '../storage/store.js';
import { refused } from './refusal.js';

/** F7.2 uses the same producer and historical derivation as the operation frame. */
export function prepareWorksFrame(store: Store, request: CandidateRequest): CandidateResult<PreparedCandidate> {
  if (request?.frame?.level !== 3) return refused('candidate_level_unsupported', 'The works entry point requires L3',
    { unit: 'F7.2', target: 'candidate', field: 'level' }, 'producer');
  return prepareCandidate(store, request);
}
export function writeWorksFrame(store: Store, request: CandidateRequest): CandidateResult<CandidateWriteResult> {
  if (request?.frame?.level !== 3) return refused('candidate_level_unsupported', 'The works entry point requires L3',
    { unit: 'F7.2', target: 'candidate', field: 'level' }, 'producer');
  return writeCandidate(store, request);
}
export function readWorksFrame(store: Store, request: CandidateReadRequest): CandidateResult<Revision<FrameCandidateRecord>> {
  const result = readCandidate(store, request);
  if (result.ok && result.value.value.level !== 3) return refused('candidate_level_unsupported', 'The saved candidate is not a works frame',
    { unit: 'F7.2', target: request.candidate.id, field: 'level' }, 'producer');
  return result;
}

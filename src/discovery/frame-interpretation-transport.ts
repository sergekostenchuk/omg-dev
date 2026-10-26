import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Observation } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { projectFrameInterpretations, type FrameInterpretations } from './frame-interpretations.js';
import { collectFrameInterpretationSubject,
  type FrameInterpretationSubject, type FrameSubjectRequest } from './frame-interpretation-subject.js';
import { historicalObservation } from './response-recovery.js';

/** DR2b 2b-RESULT-TRANSPORT (codex-omg №15094): the read-only executable half of
 * 2b.1 — verify one closed FrameInterpretations answer against the exact
 * freshly proven subject of its frame and return both as one transport package
 * for a future producer (2b.2+). The request is the same exact-addressed
 * FrameSubjectRequest the subject collector takes; the answer is presented as
 * raw bytes and admitted only through the closed form: an unknown contract, a
 * missing or extra field (a selected, paid or owner mark is never part of it),
 * a malformed selector or a support outside the declared brief excerpt is
 * refused at its field. Form alone never suffices: the set's project, brief
 * source + selector, frame revision and previous set must equal the proven
 * subject byte for byte, and every support selector of every interpretation is
 * resolved through the shared historicalObservation over the saved Source
 * bytes — a structurally nested but absent JSON Pointer is a refusal, not a
 * pass. The result keeps outcome, reason, every interpretation with its
 * meaning, consequences and verbatim support texts, plus each resolved support
 * observation. 'proven' here means form and exact sources only: no record is
 * written, no model call is sent, nothing is chosen, accepted, paid or made an
 * owner act, and the semantic correctness of the texts is not derived from any
 * valid selector. */
export const FRAME_RESULT_CONTRACT = 'frame-interpretation-result/v1' as const;

/** One support selector of one interpretation, resolved verbatim over the saved
 * bytes of the proven brief source — the observation itself, in answer order. */
export interface FrameSupportObservation {
  /** The interpretation id the support belongs to. */
  interpretation: string;
  /** Its index inside that interpretation's support list. */
  index: number;
  /** The resolved excerpt: project, exact source ref, selector and saved value. */
  observation: Observation;
}

/** A form-checked, exact-source-bound transport result: the complete proven
 * subject, the closed answer at its canonical address and every resolved
 * support. Never chosen, accepted, paid or an owner act. */
export interface FrameInterpretationResult {
  contract: typeof FRAME_RESULT_CONTRACT;
  verification: 'proven';
  /** The freshly proven subject the answer is bound to. */
  subject: FrameInterpretationSubject;
  /** The closed answer value and its canonical content address. */
  answer: { id: string; value: FrameInterpretations };
  /** Every support of every interpretation, resolved on the saved source bytes. */
  supports: FrameSupportObservation[];
}

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_transport_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_transport_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const same = (left: unknown, right: unknown): boolean => canonical(left as never) === canonical(right as never);

/** Verify one presented answer against the proven subject of the request's
 * exact frame. The subject is collected fresh from the saved material, the
 * answer is decoded through the closed form, its project/brief/frame/previous
 * linkage is compared byte for byte with the proven package, and every support
 * is re-resolved on the saved source bytes. What is returned is built from the
 * proven subject and the decoded form — never the presented object as given. */
export function checkFrameInterpretationResult(store: Store, request: FrameSubjectRequest,
  answer: unknown): FrameInterpretationResult {
  if (!store || typeof store.get !== 'function') invalid('store', 'An exact record reader is required');
  const subject = collectFrameInterpretationSubject(store, request);
  const projected = projectFrameInterpretations(answer);
  const set = projected.value;
  if (set.projectId !== subject.project)
    mismatch('projectId', 'The answer is of another project');
  const brief = { source: subject.mandate.observation.source, selector: subject.mandate.observation.selector };
  if (!same({ source: set.brief.source, selector: set.brief.selector }, brief))
    mismatch('brief', 'The answer rests on another brief than the proven mandate', set.brief.source);
  if (!same(set.frame, reference(subject.frame.record)))
    mismatch('frame', 'The answer names another frame revision', set.frame);
  const previous = subject.previous === null ? null : reference(subject.previous.record);
  if (!same(set.previousSet, previous))
    mismatch('previousSet', 'The answer names another previous set',
      isRef(set.previousSet) ? set.previousSet : undefined);
  const supports: FrameSupportObservation[] = [];
  set.interpretations.forEach((item, i) => {
    item.support.forEach((selector, s) => {
      let observation: Observation;
      try {
        observation = historicalObservation(store, subject.project,
          { source: set.brief.source, selector });
      } catch {
        invalid(`interpretations.${i}.support.${s}`,
          'A support does not resolve on the saved source bytes', set.brief.source);
      }
      supports.push({ interpretation: item.id, index: s, observation });
    });
  });
  const value: FrameInterpretationResult = { contract: FRAME_RESULT_CONTRACT,
    verification: 'proven', subject, answer: { id: projected.id, value: set }, supports };
  return JSON.parse(canonical(value as never)) as FrameInterpretationResult;
}

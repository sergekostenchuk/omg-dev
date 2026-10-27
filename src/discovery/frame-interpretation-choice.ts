import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { Selector } from '../evidence/evidence.js';
import type { Store } from '../storage/store.js';
import { V7_FRAME_INTERPRETATIONS_KIND } from './v7-contracts.js';
import { decodeFrameInterpretations, frameInterpretationsId,
  type FrameInterpretations } from './frame-interpretations.js';
import type { FrameSubjectRequest } from './frame-interpretation-subject.js';
import { checkFrameInterpretationResult,
  type FrameInterpretationResult } from './frame-interpretation-transport.js';

/** DR2b 2b-CHOICE-FORM (codex-omg2 №15533): the closed form and the pure
 * projection of one future interpretation choice — the narrow DR2b.2 half that
 * is not an action. The set is proven only by the accepted checkFrameInterpretationResult
 * over the original request+answer — a caller 'proven' or verification flag is
 * never read. The choice subject binds that whole proven result plus the
 * choice's own previous — a structural input naming an earlier choice, never
 * the set's previousSet and never declared a proven authority act: the future
 * paid/owner consumer proves its origin. The answer carries the exact set at
 * its canonical address, the verbatim mandate and frame of that set, the same
 * previous, the chosen interpretation id — a real member of the set — and its
 * nonempty justification; a no_divergence set has no alternatives to choose
 * among, so its lawful result is 'none' — a preparation outcome, not a choice
 * and not a model decision. The derived identities cover every bound value; a
 * caller never picks a shortened form and a recomputed id never stands for the
 * proven bindings. Nothing is written, sent, chosen, paid, invited, applied or
 * made an owner act, and no 2b.2–2b.6 stage is claimed closed. */
export const FRAME_INTERPRETATION_CHOICE_SUBJECT = 'frame-interpretation-choice-subject/v1' as const;
export const FRAME_INTERPRETATION_CHOICE = 'frame-interpretation-choice/v1' as const;
export const FRAME_INTERPRETATION_CHOICE_PROJECTION = 'frame-interpretation-choice-projection/v1' as const;
export const FRAME_CHOICE_OUTCOMES = Object.freeze(['chosen', 'none'] as const);

/** The closed choice subject: the complete proven set package and the choice's
 * own previous — structural only, not an authority act. */
export interface FrameInterpretationChoiceSubject {
  contract: typeof FRAME_INTERPRETATION_CHOICE_SUBJECT; subject: string; project: string;
  result: FrameInterpretationResult; previous: Ref | null;
}
/** The closed choice answer: the exact set, verbatim mandate and frame, the
 * same previous, the chosen member and its justification — or 'none'. */
export interface FrameInterpretationChoice {
  contract: typeof FRAME_INTERPRETATION_CHOICE; identity: string; project: string;
  set: { id: string; value: FrameInterpretations };
  mandate: { source: Ref; selector: Selector };
  frame: Ref; previous: Ref | null;
  outcome: typeof FRAME_CHOICE_OUTCOMES[number];
  interpretation: string | null; justification: string | null;
}
/** The projected bound choice: the proven subject plus the decoded answer at
 * its derived address. 'proven' means form and exact bindings only. */
export interface FrameInterpretationChoiceProjection {
  contract: typeof FRAME_INTERPRETATION_CHOICE_PROJECTION; verification: 'proven';
  subject: FrameInterpretationChoiceSubject; choice: { id: string; value: FrameInterpretationChoice };
}

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown): boolean =>
  canonical(left as never) === canonical(right as never);
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_choice_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function mismatch(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_choice_mismatch', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, any> {
  if (!object(value)) invalid(at, 'Expected an object of the closed form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function refForm(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}
function selectorForm(value: unknown, at: string): asserts value is Selector {
  if (!object(value) || (value.kind !== 'json-pointer' && value.kind !== 'text-range'))
    invalid(`${at}.kind`, 'A selector is a json-pointer or a text-range');
  if (value.kind === 'json-pointer') {
    shape(value, ['kind', 'pointer'], at);
    if (typeof value.pointer !== 'string' || !POINTER.test(value.pointer)) invalid(`${at}.pointer`, 'Expected a canonical JSON Pointer');
  } else {
    shape(value, ['kind', 'start', 'end'], at);
    if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
      || (value.start as number) < 0 || (value.end as number) <= (value.start as number))
      invalid(at, 'A text range is ordered nonnegative UTF-16 offsets, start < end');
  }
}
/** The previous of a choice: a structural Ref or null — never resolved or
 * declared an authority act here. */
function previousForm(value: unknown): asserts value is Ref | null {
  if (value !== null) refForm(value, 'previous');
}
const subjectId = (body: Omit<FrameInterpretationChoiceSubject, 'subject'>) =>
  `frame-interpretation-choice-subject:${hashJson(body as never)}`;
const choiceId = (body: Omit<FrameInterpretationChoice, 'identity'>) =>
  `frame-interpretation-choice:${hashJson(body as never)}`;
/** One detached JSON snapshot of external bytes: canonical() walks the value
 * a single time, so every enumerable property is read exactly once — a getter
 * or a changing field can never present two different objects inside one
 * decode or check. A non-JSON value or prototype is refused as form, never
 * normalized away. */
const snapshot = (input: unknown, at: string): unknown => {
  let text: string;
  try { text = canonical(input); }
  catch { invalid(at, 'Expected a closed JSON input'); }
  return JSON.parse(text!) as unknown;
};

/** The closed answer form: exact set at its canonical address, verbatim
 * mandate and frame, the choice's own previous, the outcome with its member or
 * lawful 'none', and a derived identity covering every bound value. The input
 * is snapshotted once — checks, identity and the returned bytes all read the
 * same detached value. */
export function decodeFrameInterpretationChoice(input: unknown): FrameInterpretationChoice {
  const raw = snapshot(input, 'choice');
  shape(raw, ['contract', 'identity', 'project', 'set', 'mandate', 'frame',
    'previous', 'outcome', 'interpretation', 'justification'], 'choice');
  if (raw.contract !== FRAME_INTERPRETATION_CHOICE)
    invalid('contract', `Only ${FRAME_INTERPRETATION_CHOICE} is a known choice form`);
  text(raw.project, 'project');
  shape(raw.set, ['id', 'value'], 'set');
  if (typeof raw.set.id !== 'string' || !raw.set.id.startsWith(`${V7_FRAME_INTERPRETATIONS_KIND}:`))
    invalid('set.id', 'The set is named by its canonical interpretations address');
  const value = decodeFrameInterpretations(raw.set.value);
  if (raw.set.id !== frameInterpretationsId(value))
    invalid('set.id', 'The set address does not derive from its presented content');
  shape(raw.mandate, ['source', 'selector'], 'mandate');
  refForm(raw.mandate.source, 'mandate.source'); selectorForm(raw.mandate.selector, 'mandate.selector');
  refForm(raw.frame, 'frame');
  previousForm(raw.previous);
  if (!(FRAME_CHOICE_OUTCOMES as readonly unknown[]).includes(raw.outcome))
    invalid('outcome', `An outcome is one of ${FRAME_CHOICE_OUTCOMES.join(', ')}`);
  if (raw.outcome === 'chosen') {
    text(raw.interpretation, 'interpretation');
    text(raw.justification, 'justification');
  } else {
    if (raw.interpretation !== null) invalid('interpretation', 'A none outcome names no interpretation');
    if (raw.justification !== null) invalid('justification', 'A none outcome states no justification');
  }
  const { identity: presented, ...rest } = raw;
  const body = { ...rest, set: { id: raw.set.id, value } };
  if (presented !== choiceId(body as Omit<FrameInterpretationChoice, 'identity'>))
    mismatch('identity', 'The derived identity does not cover the bound content');
  return structuredClone({ ...body, identity: presented }) as FrameInterpretationChoice;
}

/** The closed choice subject: the set proven fresh through the accepted
 * transport checker — the caller's verification flag is never read — plus the
 * choice's own previous as a structural input, snapshotted once so the bound
 * bytes are the checked bytes. */
export function prepareFrameInterpretationChoiceSubject(store: Store, request: FrameSubjectRequest,
  answer: unknown, previous: Ref | null = null): FrameInterpretationChoiceSubject {
  const prev = previous === null ? null : snapshot(previous, 'previous');
  previousForm(prev);
  const result = checkFrameInterpretationResult(store, request, answer);
  const body: Omit<FrameInterpretationChoiceSubject, 'subject'> = {
    contract: FRAME_INTERPRETATION_CHOICE_SUBJECT, project: result.subject.project, result, previous: prev };
  return structuredClone({ ...body, subject: subjectId(body) }) as FrameInterpretationChoiceSubject;
}

/** The pure projector on checked inputs: the presented choice is decoded
 * closed and every bound value — project, exact set content, verbatim mandate,
 * frame and previous — is compared with the proven subject byte for byte; a
 * no_divergence set yields its lawful 'none', a material set requires a real
 * member id. The subject is snapshotted once and its own derived identity is
 * re-checked, so a tampered or changing basis never stands. */
export function projectFrameInterpretationChoice(subject: FrameInterpretationChoiceSubject,
  presented: unknown): FrameInterpretationChoiceProjection {
  const choice = decodeFrameInterpretationChoice(presented);
  const basis = snapshot(subject, 'subject');
  shape(basis, ['contract', 'subject', 'project', 'result', 'previous'], 'subject');
  if (basis.contract !== FRAME_INTERPRETATION_CHOICE_SUBJECT)
    invalid('subject.contract', 'A prepared frame-interpretation-choice-subject is required');
  text(basis.project, 'subject.project');
  shape(basis.result, ['contract', 'verification', 'subject', 'answer', 'supports'], 'subject.result');
  shape(basis.result.answer, ['id', 'value'], 'subject.result.answer');
  const value = decodeFrameInterpretations(basis.result.answer.value);
  if (basis.result.answer.id !== frameInterpretationsId(value))
    invalid('subject.result.answer.id', 'The subject set address does not derive from its content');
  previousForm(basis.previous);
  const { subject: presentedId, ...body } = basis;
  if (presentedId !== subjectId(body as Omit<FrameInterpretationChoiceSubject, 'subject'>))
    mismatch('subject', 'The subject identity does not cover its bound content');
  const set = { id: basis.result.answer.id, value };
  if (choice.project !== basis.project)
    mismatch('project', 'The choice is of another project');
  if (!same(choice.set, set))
    mismatch('set', 'The choice binds another set than the proven one');
  if (!same(choice.mandate, set.value.brief))
    mismatch('mandate', 'The choice names another verbatim mandate', choice.mandate.source);
  if (!same(choice.frame, set.value.frame))
    mismatch('frame', 'The choice names another frame revision', choice.frame);
  if (!same(choice.previous, basis.previous))
    mismatch('previous', 'The choice names another previous choice',
      isRef(choice.previous) ? choice.previous : undefined);
  if (set.value.outcome === 'no_divergence') {
    if (choice.outcome !== 'none')
      mismatch('outcome', 'A no_divergence set carries no choice among alternatives');
  } else if (choice.outcome !== 'chosen')
    mismatch('outcome', 'A material set needs its chosen interpretation');
  else if (choice.interpretation === null
    || !set.value.interpretations.some(item => item.id === choice.interpretation))
    mismatch('interpretation', 'The chosen interpretation is not a member of the proven set');
  return structuredClone({ contract: FRAME_INTERPRETATION_CHOICE_PROJECTION,
    verification: 'proven', subject: basis, choice: { id: choice.identity, value: choice } }) as FrameInterpretationChoiceProjection;
}

/** The read-only door: the original request+answer is verified again through
 * checkFrameInterpretationResult — a presented 'proven' package or flag is
 * never trusted — the subject is prepared with its structural previous, and
 * the choice is decoded and bound. Read-only: no record is written and no call
 * is made. */
export function checkFrameInterpretationChoice(store: Store, request: FrameSubjectRequest,
  answer: unknown, previous: Ref | null, presented: unknown): FrameInterpretationChoiceProjection {
  const subject = prepareFrameInterpretationChoiceSubject(store, request, answer, previous);
  return projectFrameInterpretationChoice(subject, presented);
}

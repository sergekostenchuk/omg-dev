import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import type { Selector } from '../evidence/evidence.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision } from '../storage/store.js';
import { V7_FRAME_INTERPRETATIONS_CONTRACT, V7_FRAME_INTERPRETATIONS_KIND } from './v7-contracts.js';

/** DR2b 2b.1-F (codex-omg №9189, №9532): the closed structural form of one exact
 * set of material interpretations of the brief (карта, ndisc.d1.n5 — the owner
 * is asked only when the brief reads differently and the result changes). The
 * set binds the project, the exact brief — its source and exact excerpt by the
 * Observation address, never a retelling — and the exact frame proposal
 * revision; the link to a previous set is its own and is not the later
 * previous of a decision. No material divergence is its own lawful outcome with
 * a reason and no alternatives; a material divergence carries at least two
 * interpretations distinct by id, each with its meaning, its consequences for
 * the result, boundaries, constraints or acceptance criterion, and its addressed
 * support inside the verbatim brief. The interpretations are the model's: no
 * field passes them off as the owner's words or decision, and no selected,
 * accepted or owner-approved mark is part of the form. Structural only: the
 * code checks the form, the addresses and uniqueness — never the materiality of
 * the texts; the meaning of the support and the origin of a real set are
 * proven by the consumer before a choice (2b.2/2b.4), the application in 2b.5. */
export const FRAME_INTERPRETATION_OUTCOMES = Object.freeze(['no_divergence', 'material'] as const);
/** What a consequence of an interpretation names as affected. */
export const FRAME_INTERPRETATION_AFFECTS = Object.freeze(['result', 'boundaries', 'constraints', 'acceptance'] as const);
/** A canonical JSON Pointer (RFC 6901): empty, or /-separated segments where ~ is only ~0 or ~1. */
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

/** The exact brief: its source record and the exact excerpt of it (the Observation address). */
export interface FrameBrief { source: Ref; selector: Selector }
export interface FrameConsequence { affects: typeof FRAME_INTERPRETATION_AFFECTS[number]; text: string }
export interface FrameInterpretation { id: string; meaning: string; consequences: FrameConsequence[]; support: Selector[] }
export interface FrameInterpretations {
  contract: typeof V7_FRAME_INTERPRETATIONS_CONTRACT; projectId: string;
  brief: FrameBrief; frame: Ref; previousSet: Ref | null;
  outcome: typeof FRAME_INTERPRETATION_OUTCOMES[number]; reason: string; interpretations: FrameInterpretation[];
}
export interface FrameInterpretationsView { get<T = unknown>(id: string, revision?: number): Revision<T> | null }
/** A structural read result — deliberately not a proven, chosen or accepted set. */
export interface StructuralFrameInterpretations { verification: 'structural'; record: Revision<FrameInterpretations> }

function invalid(field: string, message: string, ref?: Ref): never {
  throw new EngineError('frame_interpretations_invalid', `[${field}] ${message}`, { field, ...(ref ? { ref } : {}) });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exactly these keys: a missing key is an absence, an extra one (such as a selected mark) is no part of the form. */
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed interpretations form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the interpretations form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'Expected an exact reference');
}
function selector(value: unknown, at: string): asserts value is Selector {
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
/** A support lies inside the verbatim brief excerpt: a subrange of its text range, or its pointer or one below it. */
function inside(support: Selector, brief: Selector): boolean {
  if (support.kind === 'text-range' && brief.kind === 'text-range')
    return brief.start <= support.start && support.end <= brief.end;
  if (support.kind === 'json-pointer' && brief.kind === 'json-pointer')
    return support.pointer === brief.pointer || support.pointer.startsWith(`${brief.pointer}/`);
  return false;
}

function interpretation(value: unknown, at: string, brief: Selector): string {
  shape(value, ['id', 'meaning', 'consequences', 'support'], at);
  text(value.id, `${at}.id`); text(value.meaning, `${at}.meaning`);
  const consequences = value.consequences;
  if (!Array.isArray(consequences) || !consequences.length) invalid(`${at}.consequences`, 'An interpretation names its consequences');
  consequences.forEach((item: unknown, c: number) => {
    shape(item, ['affects', 'text'], `${at}.consequences.${c}`);
    if (!(FRAME_INTERPRETATION_AFFECTS as readonly unknown[]).includes(item.affects))
      invalid(`${at}.consequences.${c}.affects`, `A consequence affects one of ${FRAME_INTERPRETATION_AFFECTS.join(', ')}`);
    text(item.text, `${at}.consequences.${c}.text`);
  });
  if (new Set(consequences.map(item => canonical(item))).size !== consequences.length)
    invalid(`${at}.consequences`, 'Each consequence is named once');
  const support = value.support;
  if (!Array.isArray(support) || !support.length) invalid(`${at}.support`, 'An interpretation rests on the verbatim brief');
  support.forEach((item: unknown, s: number) => {
    selector(item, `${at}.support.${s}`);
    if (!inside(item, brief)) invalid(`${at}.support.${s}`, 'A support lies inside the exact brief excerpt');
  });
  if (new Set(support.map(item => canonical(item))).size !== support.length) invalid(`${at}.support`, 'Each support is named once');
  return value.id;
}

/** The closed form of one set. An unknown contract is refused, never read as this one. */
export function decodeFrameInterpretations(value: unknown): FrameInterpretations {
  if (!object(value) || value.contract !== V7_FRAME_INTERPRETATIONS_CONTRACT)
    invalid('contract', `Only ${V7_FRAME_INTERPRETATIONS_CONTRACT} is a known interpretations form; another version is never read as this one`);
  shape(value, ['contract', 'projectId', 'brief', 'frame', 'previousSet', 'outcome', 'reason', 'interpretations'], 'set');
  text(value.projectId, 'projectId');
  shape(value.brief, ['source', 'selector'], 'brief');
  ref(value.brief.source, 'brief.source'); selector(value.brief.selector, 'brief.selector');
  ref(value.frame, 'frame');
  if (value.previousSet !== null) {
    ref(value.previousSet, 'previousSet');
    if (!value.previousSet.id.startsWith(`${V7_FRAME_INTERPRETATIONS_KIND}:${value.projectId}:`))
      invalid('previousSet', 'A previous set is an interpretations set of this project');
  }
  if (!(FRAME_INTERPRETATION_OUTCOMES as readonly unknown[]).includes(value.outcome))
    invalid('outcome', `An outcome is one of ${FRAME_INTERPRETATION_OUTCOMES.join(', ')}`);
  text(value.reason, 'reason');
  const list = value.interpretations;
  if (!Array.isArray(list)) invalid('interpretations', 'Expected the list of interpretations');
  if (value.outcome === 'no_divergence' && list.length) invalid('interpretations', 'No material divergence carries no alternatives');
  if (value.outcome === 'material' && list.length < 2)
    invalid('interpretations', 'A material divergence carries at least two interpretations');
  const ids = new Set<string>(), excerpt = value.brief.selector;
  list.forEach((item: unknown, i: number) => {
    const id = interpretation(item, `interpretations.${i}`, excerpt);
    if (ids.has(id)) invalid(`interpretations.${i}.id`, 'Each interpretation has its own id');
    ids.add(id);
  });
  return structuredClone(value) as unknown as FrameInterpretations;
}

/** The canonical address of a set: immutable, content-addressed, revision 1. */
export function frameInterpretationsId(value: { projectId: string }): string {
  return `${V7_FRAME_INTERPRETATIONS_KIND}:${value.projectId}:${hashJson(value as never)}`;
}
/** The pure projector — the closed form and its address; the input is never mutated. */
export function projectFrameInterpretations(value: unknown): { id: string; value: FrameInterpretations } {
  const decoded = decodeFrameInterpretations(value);
  return { id: frameInterpretationsId(decoded), value: decoded };
}
/** The exact structural reader: the record at its exact Ref, of this kind and
 * project, at its canonical address and first revision, in the closed form.
 * Only immutable bytes are checked — the result is structural, not chosen or accepted. */
export function readFrameInterpretationsStructural(view: FrameInterpretationsView, project: string, at: Ref): StructuralFrameInterpretations {
  ref(at, 'record');
  if (!view || typeof view.get !== 'function') invalid('view', 'An exact record reader is required');
  const row = view.get<unknown>(at.id, at.revision);
  if (!row || row.kind !== V7_FRAME_INTERPRETATIONS_KIND || !Object.hasOwn(row, 'value')
    || canonical(reference(row)) !== canonical(at) || hashJson(row.value as never) !== at.hash)
    invalid('record', 'The exact record kind, revision or content hash does not match', at);
  const value = decodeFrameInterpretations(row.value);
  if (value.projectId !== project || row.id !== frameInterpretationsId(value) || row.revision !== 1)
    invalid('record', 'Foreign project or noncanonical set address', at);
  return { verification: 'structural', record: { ...row, value } };
}

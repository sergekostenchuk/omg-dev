import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference } from '../pipeline/contracts.js';
import { storeView } from '../storage/store-view.js';
import type { Store, Revision } from '../storage/store.js';
import type { DiscoveryDraft, Fact, Question } from './discovery.js';
import { collectFrameInterpretationSubject } from './frame-interpretation-subject.js';
import { checkV7PlanCoverage, hasV7PlanCoverage, isDiscoveryV7Draft } from './v7-contracts.js';

export const V7_PLAN_ASSESSMENT_PROMPT = `Evaluate the plan against the entire accepted frame and verbatim mandate in planBasis, not only the author's citations. For every one of the twelve axes, verify that the linked questions together cover its domain, roles, sources and required depth. A brief question cannot replace deep research. Judge whether each inapplicable reason is specific to this project and supported by the mandate and accepted frame; a generic excuse is insufficient. A plan cannot redefine the accepted frame: a contradiction requires correction, never supported. Check blocking questions, measurable criteria and planned searches for analogues; planned searches are not completed research or evidence that no analogues exist. Return insufficient or conflicting with addressed axis/question reasons for insufficient coverage, unjustified exclusion, inadequate depth or contradiction; supported only when all obligations hold.`;

const obj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a: unknown, b: unknown) => canonical(a as Json) === canonical(b as Json);
function invalid(field: string, message: string): never {
  throw new EngineError('plan_basis_invalid', `[${field}] ${message}`, { field });
}

/** Uses the existing accepted-frame/brief collector; no local acceptance or Source proof. */
export function readV7PlanBasis(store: Store, draft: DiscoveryDraft, question: Revision<Question>, candidate?: Json) {
  if (!obj(question) || question.kind !== 'question' || !obj(question.value) || !obj(question.value.spec))
    invalid('question', 'Plan basis needs a saved question record');
  if (!isDiscoveryV7Draft(draft) || !hasV7PlanCoverage(question.value.spec)) return null;
  if (!Array.isArray(draft.questions) || !obj(draft.fields) || typeof draft.projectId !== 'string'
    || typeof question.value.draftId !== 'string' || question.value.projectId !== draft.projectId)
    invalid('draft', 'Plan basis needs its project, fields and question addresses');
  const saved = store.get<Question>(question.id, question.revision);
  if (!saved || saved.kind !== 'question' || saved.hash !== question.hash || hashJson(saved.value) !== saved.hash
    || !same(saved.value, question.value)) invalid('question', 'The plan question differs from its exact saved record');
  const current = store.get<DiscoveryDraft>(question.value.draftId);
  if (!current || current.kind !== 'discovery-draft' || !same(current.value, draft)
    || hashJson(current.value) !== current.hash || !draft.questions.includes(question.id))
    invalid('draft', 'The plan needs its exact current draft');
  const accepted = (field: string) => {
    const rows = draft.questions.map(id => store.get<Question>(id))
      .filter(q => q?.value?.spec?.field === field);
    const q = rows[0];
    if (rows.length !== 1 || !q || q.kind !== 'question' || !obj(q.value)
      || q.value.projectId !== draft.projectId || q.value.draftId !== current.id
      || q.value.status !== 'answered' || !isRef(q.value.answer) || hashJson(q.value) !== q.hash)
      invalid(field, 'The plan needs the accepted frame and original brief, not an open or missing field');
    return q;
  };
  const frame = accepted('frame'), brief = accepted('brief');
  const fact = store.get<Fact>(brief.value.answer!.id, brief.value.answer!.revision);
  if (!fact || fact.kind !== 'fact' || fact.hash !== brief.value.answer!.hash || !obj(fact.value)
    || !obj(fact.value.observation) || !isRef(fact.value.observation.source)
    || !obj(fact.value.observation.selector) || hashJson(fact.value) !== fact.hash)
    invalid('brief', 'The original brief needs its exact source and selector');
  const subject = collectFrameInterpretationSubject(store, { project: draft.projectId,
    frame: frame.value.answer!, mandate: { source: fact.value.observation.source, selector: fact.value.observation.selector } });
  if (subject.frame.draft.id !== current.id || !same(subject.frame.record.value.value, draft.fields['frame'])
    || !same(subject.mandate.observation.value, draft.fields['brief']))
    invalid('frame', 'The accepted sources must reproduce this plan draft');
  if (candidate !== undefined) {
    if (!obj(candidate) || !same(candidate['frame'], frame.value.answer))
      invalid('frame', 'The proposed plan names the exact accepted frame');
    checkV7PlanCoverage(subject.frame.record.value.value, candidate);
  }
  const guards = [reference(current), reference(frame), reference(brief)];
  return { context: { contract: 'v7-plan-basis/v1',
    frame: { answer: reference(subject.frame.record), acceptance: reference(subject.frame.acceptance), value: subject.frame.record.value.value },
    mandate: subject.mandate.observation, prefix: guards }, guards };
}


/** Re-derive a saved direct assessor's plan basis at its own prefix, never today's heads. */
export function requireV7PlanBasisAt(store: Store, question: Revision<Question>, candidate: Json, context: unknown): void {
  if (!obj(context) || context['contract'] !== 'v7-plan-basis/v1' || !Array.isArray(context['prefix'])
    || context['prefix'].length !== 3 || !context['prefix'].every(isRef))
    invalid('prefix', 'The saved plan assessment needs its exact prefix');
  const rows = context['prefix'].map(ref => {
    const row = store.get(ref.id, ref.revision);
    if (!row || row.hash !== ref.hash || hashJson(row.value) !== row.hash)
      invalid('prefix', 'The saved plan assessment lost an exact prefix record');
    return row;
  });
  const draft = rows[0]!;
  if (draft.kind !== 'discovery-draft' || !isDiscoveryV7Draft(draft.value) || draft.id !== question.value.draftId)
    invalid('draft', 'The saved plan basis belongs to its assessor question');
  const selected = new Map(rows.map(row => [row.id, row]));
  const view = storeView(store, { write: () => invalid('prefix', 'Historical plan proof is read-only'), get: <T>(id: string, revision?: number): Revision<T> | null =>
    (revision === undefined && selected.has(id) ? selected.get(id)! : store.get<T>(id, revision)) as Revision<T> | null });
  const proven = readV7PlanBasis(view, draft.value, question, candidate);
  if (!proven || !same(proven.context, context)) invalid('prefix', 'The saved plan basis differs from its proven sources');
}


/** One immutable plan-only material shared by initial packets, continuations and capacity. */
export function planBasisOf(context: Record<string, any>): Record<string, any> | null {
  const nested = Array.isArray(context.prerequisites)
    ? context.prerequisites.filter((row: any) => row?.planBasis !== undefined).map((row: any) => row.planBasis) : [];
  const values = [...(context.planBasis === undefined ? [] : [context.planBasis]), ...nested];
  if (!values.length) return null;
  const selected = values[0];
  if (!obj(selected) || selected['contract'] !== 'v7-plan-basis/v1' || !obj(selected['frame'])
    || !isRef(selected['frame']['answer']) || !obj(selected['frame']['value']) || !obj(selected['mandate'])
    || !isRef(selected['mandate']['source']) || selected['mandate']['value'] === undefined
    || values.some(value => !same(value, selected)))
    invalid('delivery', 'Plan material must retain one exact accepted frame and original mandate');
  return selected;
}

import { canonical, type Json } from '../canonical.js';
import { requireCondition } from '../errors.js';
import { isRef, reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import type { DiscoveryDraft, Question } from './discovery.js';

const stages = ['concept', 'operation-map', 'specification', 'features'] as const;
type NeighborStage = typeof stages[number];
export const STAGE_NEIGHBOR_CONTEXT = 'stage-assessment-context/v1' as const;
export const usesStageNeighbors = (stage: string): stage is NeighborStage => stages.some(value => value === stage);
export const STAGE_NEIGHBOR_INSTRUCTION = ' stageNeighbors contains only the accepted preceding fields of this draft, with exact question and answer references. Check the proposed answer against that prefix. pending names the first unanswered or reopened neighbor: its old value and later fields are not accepted grounds. Do not invent missing premises.';
export interface StageNeighbors {
  contract: 'stage-neighbors/v1';
  stage: NeighborStage;
  draft: Ref;
  question: Ref;
  fields: { field: string; question: Ref; answer: Ref; value: Json }[];
  pending: { field: string; question: Ref } | null;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Read the question order saved by this draft's producer, not today's FieldSpecs.
 * The caller chooses the material era and supplies its current or captured Store.
 * An open question is a knowledge boundary even when fields retains its old value. */
export function stageNeighbors(store: Store, draft: Revision<DiscoveryDraft>, question: Revision<Question>): {
  context: StageNeighbors | null; guards: Ref[];
} {
  if (!usesStageNeighbors(draft.value.stage)) return { context: null, guards: [] };
  const bound = (condition: unknown, id: string, message: string): void =>
    requireCondition(condition, 'stage_neighbors_binding_invalid', `[${id}] ${message}`);
  const ids = draft.value.questions;
  bound(draft.kind === 'discovery-draft' && Array.isArray(ids) && ids.every(id => typeof id === 'string')
    && new Set(ids).size === ids.length, draft.id, 'The stage needs its exact ordered questions');
  bound(question.kind === 'question' && question.value.draftId === draft.id
    && question.value.projectId === draft.value.projectId && question.value.stage === draft.value.stage
    && ids.includes(question.id), question.id, 'The selected question belongs to another draft');
  const savedDraft = store.get<DiscoveryDraft>(draft.id), savedQuestion = store.get<Question>(question.id);
  bound(savedDraft && same(reference(savedDraft), reference(draft)), draft.id, 'The selected draft changed');
  bound(savedQuestion && same(reference(savedQuestion), reference(question)), question.id, 'The selected question changed');
  const guards = [reference(draft), reference(question)];
  const context: StageNeighbors = { contract: 'stage-neighbors/v1', stage: draft.value.stage as NeighborStage,
    draft: reference(draft), question: reference(question), fields: [], pending: null };
  const fields = new Set<string>();
  for (const id of ids.slice(0, ids.indexOf(question.id))) {
    const q = store.get<Question>(id);
    requireCondition(q?.kind === 'question' && q.value.projectId === draft.value.projectId
      && q.value.draftId === draft.id && q.value.stage === draft.value.stage && q.value.spec
      && typeof q.value.spec.field === 'string', 'stage_neighbors_binding_invalid', `[${id}] The neighboring question is missing or foreign`);
    const field = q.value.spec.field;
    bound(!fields.has(field) && field !== question.value.spec.field, id, 'Neighbor fields must be distinct');
    fields.add(field);
    guards.push(reference(q));
    bound(['open', 'unresolved', 'answered'].includes(q.value.status), id, 'The neighbor lost its answer status');
    if (q.value.status !== 'answered') {
      context.pending = { field, question: reference(q) };
      break;
    }
    const ref = q.value.answer;
    requireCondition(isRef(ref), 'stage_neighbors_binding_invalid', `[${id}] The accepted neighbor lost its exact answer`);
    const answer = store.get<{ projectId: string; question: string; value?: Json; observation?: { value: Json } }>(ref.id, ref.revision);
    requireCondition(answer && same(reference(answer), ref) && answer.value.projectId === draft.value.projectId
      && answer.value.question === id && (answer.kind === q.value.spec.kind || answer.kind === 'research-answer'),
      'stage_neighbors_binding_invalid', `[${id}] The accepted answer is missing or belongs to another question`);
    const value = answer.kind === 'fact' ? answer.value.observation?.value : answer.value.value;
    requireCondition(value !== undefined && Object.hasOwn(draft.value.fields, field)
      && same(value, draft.value.fields[field]), 'stage_neighbors_binding_invalid', `[${id}] The accepted question/answer pair differs from the draft field`);
    context.fields.push({ field, question: reference(q), answer: ref, value: structuredClone(value) });
    guards.push(ref);
  }
  return { context, guards: uniqueRefs(guards) };
}

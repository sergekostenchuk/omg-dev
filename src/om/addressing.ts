import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { KNOWLEDGE_KINDS as ENGINE_KINDS } from '../graph/obligation-policy.js';
import { LEVEL, type Graph } from '../graph/model.js';
import { isRef, reference, type Ref, type StageArtifact } from '../pipeline/contracts.js';
import { Store, type Revision, type TransactionGuard, type Write, storeObserved } from '../storage/store.js';
import { provenStore } from '../storage/store-view.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { delivered, refused, sealed, type OmResult, type Refusal, type Sealed } from './refusal.js';
import { readRecord, writeGuarded } from './refs.js';
import { readLayerEnvelope, readLayerAcceptance, type LayerAcceptanceRequest } from './layer-basis.js';
import { prepareLayerAcceptance } from './frame-obligations.js';
import { readOmInput, prepareExistingOmInput, prepareReopenOmInput, deriveOmInput, withHistoricalReads, type InputBuildResult, type OmInput, type OmInputRecord, type InputGap } from './input.js';
import { readAnswerForInput } from './accepted-answer.js';
import { OWNER_COMMAND_KIND, OWNER_RESULT_KIND, ownerCommandPrefix, ownerResultNamespace, type OwnerCommand, type OwnerResult } from './owner-result.js';

export const ADDRESSING_KINDS = sealed([...ENGINE_KINDS]);
export const ADDRESSING_CHECK_KINDS = sealed(['test', 'full-run', 'environment-observation'] as const);
export const ADDRESSING_CODES = Object.freeze([
  'addressing_invalid', 'addressing_overrides_producer', 'addressing_conflict', 'addressing_source_invalid', 'addressing_field_unsupported',
] as const);
export interface AddressingDecision { question: string; consumer: string; kind: typeof ENGINE_KINDS[number]; basis: Ref }
export interface InputFieldDecision { target: string; field: 'address' | 'nodes' | 'state' | 'checkKind' | 'answer'; value: Json; basis: Ref }
export interface AddressingResult { result: InputBuildResult; refusals: Refusal[] }
export interface InputDecisionProposal {
  project: string; input: Ref; graph: Ref; layers: Ref[];
  decision: { target: string; field: InputFieldDecision['field']; value: Json };
}
export const INPUT_DECISION_KIND = 'input-decision';
export type InputDecisionBasis = { record: Ref } | { pending: Write };
export interface AddressingRequest { project: string; input: Ref; graph: Ref; decisions: InputDecisionBasis[] }
export interface PreparedAddressing<G extends TransactionGuard = TransactionGuard> {
  record: Revision<OmInputRecord>; writes: Write[]; guards: G[]; references: Ref[];
}
export interface ApplyAnswerRequest { project: string; input: Ref; answer: Ref; question: Ref }
const object = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = <T>(values: readonly T[]) => [...values].sort((a, b) => order(canonical(a), canonical(b)));
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const unique = <T>(values: readonly T[]) => sorted([...new Map(values.map(value => [canonical(value), value])).values()]);
class AddressingFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function fail(code: string, target: string, field: string, message: string): never {
  const refusal = refused(code, message, { unit: 'F5.3', target, field }, 'producer');
  if (!refusal.ok) throw new AddressingFailure(refusal.refusal);
  throw new Error('Unreachable refusal');
}
function check(condition: unknown, code: string, target: string, field: string, message: string): asserts condition {
  if (!condition) fail(code, target, field, message);
}
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new AddressingFailure(result.refusal); return result.value; }
function run<T>(action: () => T): OmResult<Sealed<T>> {
  return withHistoricalReads(() => {
    try { return delivered(action()); }
    catch (error) { if (error instanceof AddressingFailure) return { ok: false, refusal: error.refusal }; throw error; }
  });
}
function checkHeads(store: Store, guards: readonly TransactionGuard[], code: string, field: string, message: string): void {
  const checked = uniqueTransactionGuards(guards);
  if (checked.length === 0) return;
  const source = provenStore(store);
  if (source !== null && !storeObserved(source)) {
    const match = source.headsMatch(checked);
    if (!match.ok) {
      const mismatch = match.mismatches[0];
      check(false, code, mismatch?.id ?? checked[0]!.id, field, message);
    }
    return;
  }
  for (const guard of checked) {
    const current = store.get(guard.id);
    const ok = 'absent' in guard ? current === null
      : current !== null && current.revision === guard.revision && current.hash === guard.hash;
    if (!ok) {
      check(false, code, guard.id, field, message);
    }
  }
}
function invalid(field: string): never {
  throw new EngineError('addressing_request_invalid', 'Addressing needs explicit well-formed arguments', { unit: 'F5.3', target: 'om-input', field });
}
function copy<T>(value: T): T {
  try { return sealed(value) as T; }
  catch (error) { if (error instanceof EngineError && error.code === 'unsealable_value') invalid('json'); throw error; }
}
function requirePure(input: unknown, decisions: unknown, graph: unknown): asserts input is InputBuildResult {
  if (!object(input) || !Array.isArray(input.refusals) || !Array.isArray(input.gaps) || !(input.input === null || object(input.input))) invalid('inputResult');
  if (!Array.isArray(decisions)) invalid('decisions');
  if (!object(graph) || !Array.isArray(graph.nodes) || !graph.nodes.every(node => object(node) && text(node.id) && text(node.kind))
    || !(graph.actors === undefined || Array.isArray(graph.actors) && graph.actors.every(actor => object(actor) && text(actor.id)))) invalid('graph');
  if (input.input && (!['sources', 'requirements', 'criteria', 'contracts', 'features', 'questions'].every(key => Array.isArray(input.input[key]))
    || !input.input.questions.every((q: unknown) => object(q) && text(q.id) && text(q.consumer) && Object.hasOwn(q, 'kind'))
    || !input.input.contracts.every((c: unknown) => object(c) && text(c.id) && (c.nodes === null || Array.isArray(c.nodes)) && object(c.state))
    || !input.input.criteria.every((c: unknown) => object(c) && text(c.id) && Object.hasOwn(c, 'checkKind')))) invalid('inputResult.input');
  if (!(input.hash === null || typeof input.hash === 'string')) invalid('inputResult.hash');
}
function fieldDecision(value: unknown): asserts value is InputFieldDecision {
  if (!object(value) || !text(value.target) || !text(value.field) || !Object.hasOwn(value, 'value') || !isRef(value.basis)) invalid('decision');
}
/**
 * OWN1 (№3711, №3714): a decision of the model in the bypass — what is decided and why, and the two or three other
 * options it weighed, each with what it would lead to. Checked by content on receipt: real words, no placeholder, the
 * options distinct from the decision and from each other. The owner sees all of it (om-decisions) and may choose later.
 */
export interface ModelDecision { decision: string; rationale: string; alternatives: { option: string; consequences: string }[] }
const PLACEHOLDERS = new Set(['', '-', 'n/a', 'na', 'none', 'unknown', 'tbd', 'todo', 'нет', 'неизвестно', 'не знаю', '?']);
const said = (value: unknown, words: number): value is string => text(value)
  && !PLACEHOLDERS.has(value.trim().toLowerCase()) && value.trim().split(/\s+/).length >= words;
export function decidedAnswer(value: unknown): value is ModelDecision {
  if (!object(value) || Object.keys(value).length !== 3 || !said(value.decision, 2) || !said(value.rationale, 3)
    || !Array.isArray(value.alternatives) || value.alternatives.length < 2 || value.alternatives.length > 3) return false;
  const options = [(value.decision as string).trim().toLowerCase()];
  for (const item of value.alternatives as unknown[]) {
    if (!object(item) || Object.keys(item).length !== 2 || !said(item.option, 2) || !said(item.consequences, 3)) return false;
    const option = (item.option as string).trim().toLowerCase();
    if (options.includes(option)) return false;
    options.push(option);
  }
  return true;
}
/**
 * OWN1 (№3719 P2-1): the owner's own answer of a question the bypass would give to the model — the exact proved H2
 * result and its value. It stands above the model's: the question leaves the input decided by the owner. Its proof is
 * D3's (deriveInputDecisions), never the model's: E3 accepts only a ModelDecision from a model.
 */
export interface OwnerDecided { owner: Ref; value: Json }
export function ownerDecided(value: unknown): value is OwnerDecided {
  return object(value) && Object.keys(value).length === 2 && isRef(value.owner) && Object.hasOwn(value, 'value')
    && value.owner.id.startsWith('om-owner-result:');
}
/** Pure F5.3 transition. Saved operations additionally prove the base, graph and proposal references. */
export function applyInputDecisions(inputResult: InputBuildResult, decisions: InputFieldDecision[], graph: Graph): Sealed<AddressingResult> {
  requirePure(inputResult, decisions, graph);
  for (const decision of decisions) fieldDecision(decision);
  inputResult = copy(inputResult); decisions = sorted(copy(decisions)); graph = copy(graph);
  const original = inputResult;
  try {
    check(inputResult.input && inputResult.refusals.length === 0 && inputResult.hash === hashJson(inputResult.input),
      'addressing_invalid', 'om-input', 'input', 'Only a valid G1 input with addressed gaps may be amended');
    const input = structuredClone(inputResult.input), gaps = structuredClone(inputResult.gaps);
    const seen = new Set<string>(), nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const participants = new Set([...nodes.keys(), ...(graph.actors ?? []).map(actor => actor.id)]);
    for (const decision of decisions) {
      const key = canonical([decision.target, decision.field]);
      check(!seen.has(key), 'addressing_invalid', decision.target, decision.field, 'A field has exactly one decision in a batch'); seen.add(key);
      const { target, field, basis } = decision;
      const value: unknown = decision.value;
      if (field === 'address') {
        check(object(value) && text(value.consumer) && (ADDRESSING_KINDS as readonly unknown[]).includes(value.kind)
          && Object.keys(value).every(key => ['consumer', 'kind'].includes(key)) && nodes.has(value.consumer),
          'addressing_invalid', target, field, 'Addressing needs a real consumer node and an allowed knowledge kind');
        const matches = input.questions.filter(q => q.id === target);
        check(matches.length === 1, 'addressing_invalid', target, field, 'The exact predecessor question must exist once');
        const question = matches[0]!;
        if (question.addressedBy) {
          check(question.consumer === value.consumer && question.kind === value.kind && same(question.addressedBy, basis),
            'addressing_conflict', target, field, 'An accepted address cannot be replaced');
          continue;
        }
        const consumerKnown = nodes.has(question.consumer), kindKnown = question.kind !== null;
        check((!consumerKnown || question.consumer === value.consumer) && (!kindKnown || question.kind === value.kind),
          'addressing_overrides_producer', target, field, 'Every already supplied producer field must be preserved');
        if (consumerKnown && kindKnown) continue;
        question.originalConsumer = question.consumer;
        question.consumer = value.consumer; question.kind = value.kind; question.addressedBy = basis;
      } else if (field === 'nodes') {
        check(Array.isArray(value) && value.length > 0 && value.every(id => text(id) && nodes.get(id)?.kind === 'block')
          && new Set(value).size === value.length, 'addressing_invalid', target, field, 'Contract bindings must name an explicit nonempty set of existing blocks');
        const rows = input.contracts.filter(row => row.id === target);
        check(rows.length === 1, 'addressing_invalid', target, field, 'The contract must exist once');
        const row = rows[0]!, normalized = [...value].sort(order) as string[];
        check(row.nodes === null || same([...row.nodes].sort(order), normalized), 'addressing_overrides_producer', target, field, 'A supplied binding cannot be replaced');
        row.nodes = normalized;
      } else if (field === 'state') {
        check(object(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => ['writer', 'authority', 'rollback'].includes(key))
          && Object.values(value).every(id => text(id) && participants.has(id)),
          'addressing_invalid', target, field, 'Boundary decisions only name existing nodes or participants for missing ownership fields');
        const rows = input.contracts.filter(row => row.id === target);
        check(rows.length === 1, 'addressing_invalid', target, field, 'The contract must exist once');
        for (const [key, id] of Object.entries(value)) {
          const old = rows[0]!.state[key];
          check(!participants.has(old as string) || old === id, 'addressing_overrides_producer', target, `state.${key}`, 'A producer boundary ID cannot be replaced');
          Object.defineProperty(rows[0]!.state, key, { value: id, enumerable: true, configurable: true, writable: true });
        }
      } else if (field === 'checkKind') {
        check((ADDRESSING_CHECK_KINDS as readonly unknown[]).includes(value), 'addressing_invalid', target, field, 'A criterion needs an allowed check kind');
        const rows = input.criteria.filter(row => row.id === target);
        check(rows.length === 1, 'addressing_invalid', target, field, 'The criterion must exist once');
        check(rows[0]!.checkKind === null || rows[0]!.checkKind === value, 'addressing_overrides_producer', target, field, 'The supplied check kind cannot be replaced');
        rows[0]!.checkKind = value as string;
      } else if (field === 'answer') {
        // OWN1 (№3702, №3711): the bypass — the model decides an addressed design or owner question of the pass; the
        // decision is checked by its content on receipt and the question leaves the input, kept with its decision.
        const matches = input.questions.filter(q => q.id === target);
        // The same decision again is no change: its question already stands decided by it.
        if (!matches.length && (input.decided ?? []).some(row => row.question.id === target && same(row.value, value) && same(row.decision, basis))) continue;
        check(matches.length === 1, 'addressing_invalid', target, field, 'The exact predecessor question must exist once');
        const question = matches[0]!;
        check(nodes.has(question.consumer) && (question.kind === 'design-decision' || question.kind === 'owner-decision'),
          'addressing_field_unsupported', target, field, 'The model decides only an addressed design or owner question; facts need D3.1');
        check(decidedAnswer(value) || ownerDecided(value), 'addressing_invalid', target, field,
          'A decision names what is decided and why and two or three other options with their consequences, in words of its own');
        input.questions = input.questions.filter(q => q.id !== target);
        input.decided = [...(input.decided ?? []), { question, value: value as unknown as Json, decision: basis }]
          .sort((a, b) => order(a.question.id, b.question.id));
      } else fail('addressing_field_unsupported', target, field, 'Only missing MC2 input fields belong to F5.3; facts need D3.1');
    }
    const remaining = gaps.filter(gap => {
      if (!decisions.some(decision => decision.target === gap.target && decision.field === gap.field)) return true;
      if (gap.field === 'answer') return input.questions.some(q => q.id === gap.target);
      if (gap.code === 'contract_node_unbound') return input.contracts.find(row => row.id === gap.target)?.nodes === null;
      if (gap.code === 'acceptance_kind_missing') return input.criteria.find(row => row.id === gap.target)?.checkKind === null;
      if (gap.code === 'contract_boundary_prose') {
        const row = input.contracts.find(row => row.id === gap.target)!;
        return ['writer', 'authority', 'rollback'].some(key => !participants.has(row.state[key] as string));
      }
      return true;
    });
    return sealed({ result: { ...inputResult, input, hash: hashJson(input), gaps: remaining }, refusals: [] });
  } catch (error) {
    if (error instanceof AddressingFailure) return sealed({ result: original, refusals: [error.refusal] });
    throw error;
  }
}
export function applyAddressing(inputResult: InputBuildResult, decisions: AddressingDecision[], graph: Graph): Sealed<AddressingResult> {
  requirePure(inputResult, decisions, graph);
  for (const decision of decisions) if (!object(decision) || !text(decision.question) || !text(decision.consumer) || !text(decision.kind) || !isRef(decision.basis)) invalid('decision');
  return applyInputDecisions(inputResult, decisions.map(decision => ({ target: decision.question, field: 'address',
    value: { consumer: decision.consumer, kind: decision.kind }, basis: decision.basis })), graph);
}
export function inputDecisionNamespace(project: string): string { if (!text(project)) invalid('project'); return `om-input-decision:${project}:`; }
function requireProposal(value: unknown): asserts value is InputDecisionProposal {
  if (!object(value) || !text(value.project) || !isRef(value.input) || !isRef(value.graph) || !Array.isArray(value.layers) || !value.layers.every(isRef)
    || !object(value.decision) || !text(value.decision.target) || !text(value.decision.field) || !Object.hasOwn(value.decision, 'value')) invalid('proposal');
}
/** Normalize only unordered sets, retaining multiplicity so duplicate members remain rejectable. */
export function normalizeInputDecisionProposal(proposal: InputDecisionProposal): Sealed<InputDecisionProposal> {
  requireProposal(proposal);
  proposal = copy(proposal);
  const decision = { ...proposal.decision, value: proposal.decision.field === 'nodes' && Array.isArray(proposal.decision.value)
    ? sorted(proposal.decision.value) : proposal.decision.value };
  return sealed({ ...proposal, layers: sorted(proposal.layers), decision });
}
/** E3 can persist this proposal or include it in the F5.3 transaction; no status grants acceptance. */
export function inputDecisionWrite(proposal: InputDecisionProposal): Sealed<Write> {
  proposal = normalizeInputDecisionProposal(proposal) as InputDecisionProposal;
  return sealed({ id: `${inputDecisionNamespace(proposal.project)}${hashJson(proposal)}`, kind: INPUT_DECISION_KIND, expected: 0, value: proposal });
}
function decisionNodes(decision: InputFieldDecision): string[] {
  const value: unknown = decision.value;
  if (decision.field === 'address') return object(value) && text(value.consumer) ? [value.consumer] : [];
  if (decision.field === 'nodes') return Array.isArray(decision.value) ? decision.value.filter(text) : [];
  if (decision.field === 'state') return object(decision.value) ? Object.values(decision.value).filter(text) : [];
  return [];
}
/** B1 calls this only after verifying previous through its own shared historical reader. */
export function deriveInputDecisions(store: Store, request: { project: string; previous: Revision<OmInputRecord>; graph: Ref; decisions: Ref[] }): OmResult<Sealed<{
  input: OmInput; gaps: InputGap[]; references: Ref[]; layers: LayerAcceptanceRequest[];
}>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.graph)
    || !object(request.previous) || !isRef(reference(request.previous)) || !object(request.previous.value)
    || !Array.isArray(request.decisions) || !request.decisions.every(isRef)) invalid('derivation');
  return run(() => {
    const previous = request.previous, base = previous.value;
    check(base.projectId === request.project && previous.id === `om-input:${request.project}`, 'addressing_source_invalid', previous.id, 'input', 'The decision needs this project input');
    check(object(base.input) && Array.isArray(base.input.sources), 'addressing_source_invalid', previous.id, 'input', 'A checked input body is required');
    const map = base.input.sources.find(source => source.stage === 'operation-map');
    check(map, 'addressing_source_invalid', previous.id, 'map', 'An accepted operation map is required');
    const stage = take(readRecord<StageArtifact>(store, map, { unit: 'F5.3', target: previous.id, id: `stage:${request.project}:operation-map`, kind: 'stage' }));
    const content: unknown = stage.value.content;
    const layerRef = object(content) ? content.graph : null;
    check(isRef(layerRef), 'addressing_source_invalid', previous.id, 'layer', 'The accepted stage must identify its L1 projection');
    const envelope = take(readLayerEnvelope(store, { project: request.project, level: 1, graph: request.graph, layer: layerRef }));
    const graph = envelope.graph.value as Graph, references: Ref[] = [reference(previous), ...envelope.references, ...request.decisions];
    const decisions: InputFieldDecision[] = [], layers: LayerAcceptanceRequest[] = [];
    for (const ref of request.decisions) {
      const proposal = take(readRecord<InputDecisionProposal>(store, ref, { unit: 'F5.3', target: ref.id, idPrefix: inputDecisionNamespace(request.project), kind: INPUT_DECISION_KIND }));
      try { requireProposal(proposal.value); }
      catch (error) { if (error instanceof EngineError && error.code === 'addressing_request_invalid') fail('addressing_source_invalid', ref.id, 'proposal', 'The saved decision proposal is incomplete'); throw error; }
      const value = proposal.value as InputDecisionProposal;
      check(value.project === request.project && same(value.input, reference(previous)) && same(value.graph, request.graph)
        && same(value, normalizeInputDecisionProposal(value)) && ref.id === inputDecisionWrite(value).id && proposal.revision === 1,
        'addressing_source_invalid', ref.id, 'basis', 'The proposal must belong to this exact base and graph');
      const decision: InputFieldDecision = { ...value.decision, basis: ref };
      if (decision.field === 'answer' && ownerDecided(decision.value)) {
        // OWN1: an owner's decision stands only on the exact H2 result of this very question, with its very value.
        const owner = decision.value as unknown as OwnerDecided;
        const result = take(readRecord<OwnerResult>(store, owner.owner,
          { unit: 'F5.3', target: decision.target, idPrefix: ownerResultNamespace(request.project), kind: OWNER_RESULT_KIND }));
        const command = take(readRecord<OwnerCommand>(store, result.value.command,
          { unit: 'F5.3', target: decision.target, idPrefix: ownerCommandPrefix(request.project), kind: OWNER_COMMAND_KIND }));
        check(result.value.project === request.project && command.value.question.route.target === decision.target
          && command.value.question.route.field === 'answer' && same(result.value.value, owner.value),
          'addressing_source_invalid', ref.id, 'owner', 'An owner decision is the exact H2 result of this question and its value');
        references.push(owner.owner, result.value.command);
      }
      const levels = unique(decisionNodes(decision).flatMap(id => {
        const node = graph.nodes.find(node => node.id === id); return node && LEVEL[node.kind] > 1 ? [LEVEL[node.kind]] : [];
      }));
      for (const level of levels) {
        const proofs = value.layers.filter(layer => layer.id === `graph-layer:${request.project}:${level}`);
        check(proofs.length === 1, 'addressing_source_invalid', ref.id, 'layers', 'A lower consumer requires its exact accepted layer');
        const layer = { project: request.project, level: level as 2 | 3, graph: request.graph, layer: proofs[0]! };
        const accepted = take(readLayerAcceptance(store, layer));
        layers.push(layer);
        references.push(...accepted.references);
      }
      check(value.layers.length === levels.length, 'addressing_source_invalid', ref.id, 'layers', 'The proof set must correspond to the referenced consumer levels');
      decisions.push(decision);
    }
    const applied = applyInputDecisions({ input: base.input, hash: base.hash, gaps: base.gaps, refusals: [] }, decisions, graph);
    if (applied.refusals.length) throw new AddressingFailure(applied.refusals[0]!);
    return { input: applied.result.input!, gaps: applied.result.gaps, references: unique(references), layers: unique(layers) };
  });
}
function requireRequest(store: Store, request: unknown): asserts request is AddressingRequest {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.input) || !isRef(request.graph)
    || !Array.isArray(request.decisions)) invalid('request');
  for (const basis of request.decisions) if (!object(basis) || (Object.hasOwn(basis, 'record') === Object.hasOwn(basis, 'pending'))
    || ('record' in basis ? !isRef(basis.record) : !object(basis.pending) || basis.pending.expected !== 0
      || basis.pending.kind !== INPUT_DECISION_KIND || !text(basis.pending.id) || !object(basis.pending.value))) invalid('decisions');
}
function viewOf(store: Store, request: AddressingRequest) {
  const pending = new Map<string, Revision>(), writes: Write[] = [], refs: Ref[] = [];
  for (const basis of request.decisions) {
    if ('record' in basis) { refs.push(basis.record); continue; }
    const write = basis.pending, row = { id: write.id, kind: write.kind, revision: 1, value: write.value as Json, hash: hashJson(write.value) };
    check(!pending.has(row.id), 'addressing_invalid', row.id, 'decisions', 'The same pending decision cannot occur twice');
    const existing = store.get(row.id);
    check(!existing || same(existing, row), 'addressing_source_invalid', row.id, 'pending', 'A pending decision cannot overwrite another record');
    pending.set(row.id, row); if (!existing) writes.push(write); refs.push(reference(row));
  }
  const view = new Proxy(store, { get(target, property) {
    if (property === 'get') return <T = Json>(id: string, revision?: number): Revision<T> | null => {
      const row = pending.get(id); return row && (revision === undefined || revision === 1) ? row as Revision<T> : target.get<T>(id, revision);
    };
    const member: unknown = Reflect.get(target, property, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  return { store: view, refs: sorted(refs), writes };
}
export function prepareAddressing(store: Store, request: AddressingRequest): OmResult<Sealed<PreparedAddressing>> {
  requireRequest(store, request); request = copy(request);
  return run(() => {
    const view = viewOf(store, request), expected = { previous: request.input, graph: request.graph, decisions: view.refs };
    const current = store.get<OmInputRecord>(`om-input:${request.project}`);
    check(current, 'addressing_source_invalid', request.project, 'input', 'An existing accepted input is required');
    const admitted = take(prepareExistingOmInput(store, request.project, reference(current)));
    let cursor = admitted.existing! as Revision<OmInputRecord>;
    while (cursor.value.derivation) {
      if (same(cursor.value.derivation, expected)) return { record: cursor, writes: [], guards: admitted.guards, references: [reference(cursor)] };
      cursor = take(readOmInput(store, request.project, cursor.value.derivation.previous)) as Revision<OmInputRecord>;
    }
    check(same(reference(current), request.input), 'addressing_conflict', request.input.id, 'input', 'A new decision names the current input; only an exact applied delivery may use an old base');
    const record = take(deriveOmInput(view.store, { project: request.project, previous: request.input, graph: request.graph, decisions: view.refs })) as OmInputRecord;
    const derived = take(deriveInputDecisions(view.store, { project: request.project, previous: current, graph: request.graph, decisions: view.refs }));
    const lowerGuards = derived.layers.flatMap(layer => take(prepareLayerAcceptance(store, layer)).guards);
    const guards = uniqueTransactionGuards([...admitted.guards, ...lowerGuards, request.graph, ...view.refs.filter(ref => !view.writes.some(write => write.id === ref.id))]);
    checkHeads(store, guards, 'addressing_source_invalid', 'head', 'A decision prerequisite changed before preparation');
    if (same(current.value.input, record.input) && same(current.value.gaps, record.gaps))
      return { record: current, writes: [], guards, references: derived.references as Ref[] };
    const next = { id: current.id, kind: current.kind, revision: current.revision + 1, hash: hashJson(record), value: record };
    return { record: next, writes: [...view.writes, { id: current.id, kind: current.kind, expected: current.revision, value: record }],
      guards, references: derived.references as Ref[] };
  });
}
export function writeAddressing(store: Store, request: AddressingRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareAddressing(store, request); if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'F5.3', target: prepared.value.record.id, writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}

/**
 * OWN1 (№3719 P2-1, OWN1.1 №3722): the D3 request that decides questions by the owner's exact proved H2 answers — all
 * of them in one B1 transition, so applying one never takes another out of its bases.
 */
export interface OwnerDecisionRequest { project: string; input: Ref; graph: Ref; owners: { target: string; owner: Ref; value: Json }[] }
export function writeOwnerDecision(store: Store, request: OwnerDecisionRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.input) || !isRef(request.graph)
    || !Array.isArray(request.owners) || !request.owners.length
    || request.owners.some(row => !object(row) || !text(row.target) || !isRef(row.owner) || !Object.hasOwn(row, 'value'))) invalid('owner');
  return writeAddressing(store, { project: request.project, input: request.input, graph: request.graph, decisions: request.owners.map(row => ({
    pending: inputDecisionWrite({ project: request.project, input: request.input, graph: request.graph, layers: [],
      decision: { target: row.target, field: 'answer', value: { owner: row.owner, value: row.value } as unknown as Json } }) as Write })) });
}
/** The fact supplier proves acceptance and applicability; B1 owns the resulting input derivation. */
export function prepareApplyAnswer(store: Store, request: ApplyAnswerRequest): OmResult<Sealed<PreparedAddressing>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.input)
    || !isRef(request.answer) || !isRef(request.question)) invalid('answer');
  request = copy(request);
  return run(() => {
    const current = store.get<OmInputRecord>(`om-input:${request.project}`);
    check(current, 'addressing_source_invalid', request.project, 'input', 'Applying a fact requires an existing input');
    const admitted = take(prepareExistingOmInput(store, request.project, reference(current)));
    const derivation = { kind: 'fact' as const, previous: request.input, answer: request.answer, question: request.question };
    let cursor = admitted.existing! as Revision<OmInputRecord>;
    while (cursor.value.derivation) {
      if (same(cursor.value.derivation, derivation)) return { record: cursor, writes: [], guards: admitted.guards,
        references: [reference(cursor), request.input, request.answer, request.question] };
      cursor = take(readOmInput(store, request.project, cursor.value.derivation.previous)) as Revision<OmInputRecord>;
    }
    check(same(reference(current), request.input), 'addressing_conflict', request.input.id, 'input',
      'A new fact application names the current input; an old base is only valid for an exact applied delivery');
    const applicable = take(readAnswerForInput(store, { project: request.project, record: request.answer,
      question: request.question, input: request.input, current: true }));
    check(applicable.applicable, 'answer_inapplicable', request.input.id, 'answer',
      'The accepted fact must still establish this exact input question under the same contract and sources');
    const record = take(deriveOmInput(store, { project: request.project, ...derivation })) as OmInputRecord;
    const guards = uniqueTransactionGuards([...admitted.guards, ...applicable.guards]);
    checkHeads(store, guards, 'input_stale', 'head', 'A fact application prerequisite changed');
    if (same(current.value.input, record.input) && same(current.value.gaps, record.gaps))
      return { record: current, writes: [], guards, references: applicable.references as Ref[] };
    const next = { id: current.id, kind: current.kind, revision: current.revision + 1, hash: hashJson(record), value: record };
    return { record: next, writes: [{ id: current.id, kind: current.kind, expected: current.revision, value: record }],
      guards, references: applicable.references as Ref[] };
  });
}
export function writeApplyAnswer(store: Store, request: ApplyAnswerRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareApplyAnswer(store, request); if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'F5.3', target: prepared.value.record.id,
        writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}

/** Return stale applied facts to the unresolved set through B1's proven derivation. */
export interface ReopenAnswersRequest { project: string; input: Ref }
export function prepareReopenAnswers(store: Store, request: ReopenAnswersRequest): OmResult<Sealed<PreparedAddressing>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project) || !isRef(request.input)) invalid('reopen');
  request = copy(request);
  return run(() => {
    const prepared = take(prepareReopenOmInput(store, request));
    const write = prepared.writes.find(write => write.id === `om-input:${request.project}`);
    const record = write ? { id: write.id, kind: write.kind, revision: write.expected + 1,
      value: prepared.record as OmInputRecord, hash: hashJson(prepared.record) } : prepared.existing as Revision<OmInputRecord>;
    check(record, 'addressing_source_invalid', request.input.id, 'input', 'Recovery requires a verified input');
    const derivation = record.value.derivation;
    const evidence = derivation && 'kind' in derivation && derivation.kind === 'reopen-facts'
      ? [...derivation.invalidations.flatMap(item => [item.record, ...item.sources.flatMap(pair => [pair.before, pair.after])]),
        ...(derivation.dependencies ?? []).flatMap(item => [item.record, item.question, ...item.removed])] : [];
    return { record, writes: prepared.writes as Write[], guards: prepared.guards,
      references: unique([request.input, reference(record), ...prepared.guards.filter(isRef), ...evidence]) };
  });
}
export function writeReopenAnswers(store: Store, request: ReopenAnswersRequest): OmResult<Sealed<Revision<OmInputRecord>>> {
  return withHistoricalReads(() => {
    const prepared = prepareReopenAnswers(store, request); if (!prepared.ok) return prepared;
    if (prepared.value.writes.length) {
      const written = writeGuarded(store, { unit: 'F5.3', target: prepared.value.record.id,
        writes: prepared.value.writes, guards: prepared.value.guards });
      if (!written.ok) return written;
    }
    return delivered(prepared.value.record);
  });
}

/** OWN1 (№3714): one question the bypass decided — what was asked, of whom, what the model chose, the options it weighed. */
export interface BypassDecision {
  id: string; question: string; kind: string | null; consumer: string;
  /** Who decided: the model in the bypass, or the owner by an explicit H2 answer (OWN1 №3719), which stands above it. */
  by: 'model' | 'owner'; owner: Ref | null;
  decision: string; rationale: string; alternatives: ModelDecision['alternatives'];
  /** The exact input decision, the first B1 that holds it, and the model call that produced that B1 with its start (ISO). */
  record: Ref; input: Ref; call: Ref | null; at: string | null;
}
/**
 * The questions of the current B1 decided in the bypass, for the owner to read. Nothing is written or checked anew: each
 * row is the B1 entry as recorded, the first B1 revision that holds it, and the E4 whose applied input that revision is.
 */
export function listBypassDecisions(store: Store, request: { project: string }): OmResult<Sealed<{ input: Ref | null; decisions: BypassDecision[] }>> {
  if (!(store instanceof Store) || !object(request) || !text(request.project)) invalid('project');
  return withHistoricalReads(() => {
    const id = `om-input:${request.project}`, head = store.get<OmInputRecord>(id);
    if (!head) return delivered(sealed({ input: null, decisions: [] }));
    const decided = head.value.input.decided ?? [];
    const firstHolding = (question: string): Revision<OmInputRecord> => {
      for (let revision = 1; revision <= head.revision; revision++) {
        const found = store.get<OmInputRecord>(id, revision);
        if (found && (found.value.input.decided ?? []).some(row => row.question.id === question)) return found;
      }
      return head;
    };
    const calls = decided.length ? store.list<{ startedAt?: number; om?: { input?: Ref | null } }>('model-call')
      .filter(row => row.id.startsWith(`model-call:${request.project}:om:`)) : [];
    const decisions = decided.map((row): BypassDecision => {
      const input = reference(firstHolding(row.question.id)), owned = ownerDecided(row.value);
      const value = owned ? null : row.value as unknown as ModelDecision, owner = owned ? row.value as unknown as OwnerDecided : null;
      const call = owned ? undefined : calls.find(item => item.value.om?.input && same(item.value.om.input, input));
      return { id: row.question.id, question: row.question.question, kind: row.question.kind as string | null, consumer: row.question.consumer,
        by: owned ? 'owner' : 'model', owner: owner ? owner.owner : null,
        decision: owner ? (typeof owner.value === 'string' ? owner.value : canonical(owner.value)) : value!.decision,
        rationale: value ? value.rationale : '', alternatives: value ? value.alternatives : [], record: row.decision, input,
        call: call ? reference(call) : null,
        at: call && Number.isFinite(call.value.startedAt) ? new Date(call.value.startedAt!).toISOString() : null };
    });
    return delivered(sealed({ input: reference(head), decisions }));
  });
}

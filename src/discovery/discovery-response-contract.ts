import { requireCondition } from '../errors.js';
import { RESEARCH_ACTION_SCHEMA, READER_REPLY_SCHEMA, compactResponseSchema } from './research-action-contract.js';
import { RESEARCH_READ_SCHEMAS } from './research-read-contract.js';
import { VARIANT_CRITERIA } from './discovery-variants.js';

const text = { type: 'string', minLength: 1 };
const closed = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const list = (items: unknown, minItems = 0) => ({ type: 'array', items, minItems });
const ref = { $ref: '#/$defs/ref' }, selector = { $ref: '#/$defs/selector' };
const defs = {
  ref: closed({ id: text, revision: { type: 'integer', minimum: 1 }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }),
  selector: { oneOf: [closed({ kind: { const: 'json-pointer' }, pointer: { type: 'string' } }),
    closed({ kind: { const: 'text-range' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } })] },
};
const readContext = RESEARCH_READ_SCHEMAS[1]!;
const checkpoint = closed({ action: { const: 'assessment_checkpoint' }, notes: list({ type: 'string' }) });
const claim = closed({ project: text, container: ref, containerKind: { enum: ['research-answer', 'research-attempt'] }, pointer: text, claimId: text });
const exact = 'Return JSON only. Objects are closed: include every required field and no undeclared fields. Nonempty text must contain non-whitespace characters. References are exact saved {id,revision,hash}, never invented. Text offsets count UTF-16 code units with half-open [start,end); JSON pointers use RFC 6901. This describes the reply, not permission to dispatch, accept, or make owner decisions. ';
const contract = (purpose: string, schema: Record<string, unknown>, instruction: string) => ({
  contract: 'discovery-response-contract/v1', purpose, schema: compactResponseSchema(schema), instruction: exact + instruction,
});

/** New dispatch guidance only. Saved questions, preparations and historical decoders retain their original forms. */
export function discoveryResponseContract(purpose: string, body: Record<string, any>): ReturnType<typeof contract> | null {
  if (body.dispatchMode === 'consolidation') purpose = 'consolidation';
  if (purpose === 'variant-proposal') {
    const judgement = closed({ conclusion: text, grounds: { ...list(ref), uniqueItems: true }, assumptions: list(text), unknowns: list(text),
      quantity: { oneOf: [{ type: 'null' }, closed({ unit: text, minimum: { type: 'number' }, maximum: { type: 'number' }, limitations: text,
        grounds: { ...list(ref, 1), uniqueItems: true } })] } });
    const reason = closed({ code: text, message: text, grounds: { ...list(ref, 1), uniqueItems: true } });
    return contract(purpose, { $defs: { ...defs, judgement }, oneOf: [
      closed({ action: { const: 'variants' }, variants: { ...list(closed({ key: text, title: text, proposal: {},
        criteria: closed(Object.fromEntries(VARIANT_CRITERIA.map(key => [key, { $ref: '#/$defs/judgement' }]))) }), 1), maxItems: 3 },
        scale: closed(Object.fromEntries(VARIANT_CRITERIA.map(key => [key, text]))), comparison: text,
        recommendation: closed({ key: text, reason: text }), searchLimits: list(text, 1), unknowns: list(text) }),
      closed({ action: { const: 'no_variants' }, reasons: list(reason, 1), searchLimits: list(text, 1), unknowns: list(text) }),
    ] }, 'Propose one to three variants with unique local keys on the same six-axis scale. recommendation.key must name one proposed key; recommendation is not a choice. Each criterion needs at least one ground, assumption or unknown. quantity is null without supported measurement; otherwise minimum <= maximum, finite numbers, limitations and at least one exact ground. no_variants is a separate result with grounded reasons and explicit search limits.');
  }
  if (purpose === 'variant-decision') return contract(purpose, { oneOf: [
    closed({ action: { const: 'choose' }, key: text, reason: text }), closed({ action: { const: 'reject_all' }, reason: text }),
  ] }, 'choose.key names an existing local key of the exact delivered set. reject_all rejects that whole set; it has no key. Preserve the bound set and project mode; do not manufacture an owner act.');
  const request = body.request ?? body;
  if (purpose === 'frame-interpretation-request') return contract(purpose, { $defs: defs, oneOf: [readContext,
    closed({ contract: { const: 'frame-interpretations/v1' }, projectId: text,
      brief: closed({ source: ref, selector }), frame: ref, previousSet: { oneOf: [ref, { type: 'null' }] },
      outcome: { enum: ['material', 'no_divergence'] }, reason: text,
      interpretations: list(closed({ id: text, meaning: text,
        consequences: { ...list(closed({ affects: { enum: ['result', 'boundaries', 'constraints', 'acceptance'] }, text }), 1), uniqueItems: true },
        support: { ...list(selector, 1), uniqueItems: true } })) }),
  ] }, 'Copy projectId from frameRequest.project and exact brief/frame/previousSet from frameRequest. material needs at least two interpretations with unique ids; no_divergence requires the field interpretations: [] (an explicit empty array), never omission. Every support selector lies inside the exact brief excerpt; no selected/accepted/paid flags. You may read_context for remaining original material.');
  if (request.interpretationPhase === 'frame') return contract(purpose, { $defs: defs, oneOf: [readContext,
    closed({ action: { const: 'frame' }, decision: ref, value: {} }),
  ] }, 'Copy the supplied exact decisionRef. value is the complete revised frame satisfying frameSchema, preserving the mandate and unaffected content. This proposal requires independent assessment.');
  if (purpose === 'frame-interpretation-choice') return contract(purpose, { oneOf: [readContext,
    closed({ action: { const: 'choose' }, interpretation: text, justification: text }),
  ] }, 'interpretation is an existing member id of the exact choiceSubject; retain its meaning and justify the choice.');
  if (purpose === 'escalation-assessor') return contract(purpose, closed({ necessary: { type: 'boolean' }, reason: text }),
    'necessary is true only for unavailable owner-only information, never technical/provider failures. Judge the delivered need_owner and actual searched records; do not answer the owner question.');
  if (purpose === 'reader') return contract(purpose, READER_REPLY_SCHEMA,
    'Select only supplied original line coordinates. sourceIndex is zero-based; firstLine and lastLine are inclusive one-based lines with firstLine <= lastLine. Preserve exceptions and conditions; do not summarize original text.');
  if (purpose === 'consolidation') return contract(purpose, closed({ action: { const: 'checkpoint' }, question: text,
    value: closed({ summaries: list(closed({ notes: { ...list({ type: 'integer', minimum: 0 }, 1), uniqueItems: true }, text }), 1),
      citationIds: { ...list({ type: 'integer', minimum: 0 }), uniqueItems: true } }), citations: { type: 'array', maxItems: 0 }, unresolved: list(text) }),
    'Use the current question id. summaries must cover every delivered input note index; citationIds must contain every supplied citation index exactly once. Preserve associations, conditions and unresolved findings. Do not invent citations, new facts, reads or a final answer. Respect the delivered targetChars and any bounded tightening instruction.');
  if (purpose === 'dossier-assessor') return contract(purpose, { oneOf: [readContext,
    closed({ action: { const: 'assessment_checkpoint' }, dossierSubject: { const: body.dossierSubject }, notes: list(text, 1) })] },
    'The terminal result uses dossierReplyContract.schema (not this continuation-only schema). Copy the exact ordered inventory, including unknowns and both sides/grounds of contradictions. supported requires return:null, all quality judgements adequate and no unresolved blocking contradiction. return requires nonempty addressed targets, reason and bases from this exact packet. The dossier assessment_checkpoint also requires the exact dossierSubject and nonempty notes per dossierReplyContract; use that complete form.');
  if (purpose === 'assessor') return contract(purpose, { oneOf: [readContext, checkpoint, ...(body.assessmentSubject ? [] : [
    closed({ verdict: { enum: ['supported', 'insufficient', 'conflicting'] }, reasons: list({ type: 'string' }) })])] },
    body.assessmentSubject
      ? 'Terminal reply must satisfy question.schema AND assessmentClassification.schema and instruction. Classify every attempt/claim; retain exact paid bases and declared methodology. This schema describes read/checkpoint continuations only.'
      : 'Terminal reply is {verdict:"supported"|"insufficient"|"conflicting",reasons:[string]}; insufficient/conflicting need at least one reason. Assess the exact field candidate against question.schema and evidence. No self-acceptance.');
  if (purpose === 'analyst' || purpose === 'synthesis' || purpose === 'reading-planner') {
    const plan = body.subject?.planQuestionId !== undefined;
    const synthesizing = purpose === 'synthesis' || body.dispatchMode === 'synthesis';
    const deep = body.deepPreparation !== undefined;
    if (deep && Object.hasOwn(body, 'deepResearchContract')) requireCondition(body.deepResearchContract === 'deep-research-cycle/v1',
      'research_deep_subject_invalid', 'An unknown deep contract cannot advertise an action protocol');
    const legacyDeep = deep && !Object.hasOwn(body, 'deepResearchContract');
    if (legacyDeep) return contract(purpose, closed({ action: { const: 'answer' }, question: text,
      value: {}, citations: { type: 'array', maxItems: 0 } }),
      'This saved deep era accepts exactly one terminal answer for the bound plan question, using question.schema and discoveryClaims.schema. citations must be an explicit empty array. It does not execute intermediate reads, web actions, checkpoints or owner escalation. Preserve the exact deep preparation/cell/scope; this delivery does not upgrade the saved execution contract.');
    const actionForms = RESEARCH_ACTION_SCHEMA.oneOf.filter((s: any) => {
      const action = s.properties.action.const;
      return purpose === 'reading-planner' ? ['read_plan', 'synthesize', 'pause'].includes(action)
        : synthesizing ? ['answer', 'checkpoint', 'read_context', 'need_research', 'need_owner', 'pause'].includes(action) && (!plan || action !== 'answer')
        : action !== 'answer_delta' && action !== 'read_plan' && action !== 'synthesize' && (!plan || action !== 'answer');
    });
    // The exact terminal value schema already travels in question.schema. The supplement
    // closes the action envelope without sending another copy of that potentially large schema.
    if (plan && purpose !== 'reading-planner') actionForms.push(closed({ action: { const: 'answer' }, question: text, value: {}, citations: { type: 'array', maxItems: 0 } }) as any);
    if (purpose === 'analyst' && !synthesizing && body.webResearch) for (const action of ['web_search', 'web_fetch']) actionForms.push(closed({
      action: { const: action }, [action === 'web_search' ? 'query' : 'url']: { ...text, maxLength: action === 'web_search' ? 500 : 2048 },
      purpose: { ...text, maxLength: 1000 } }) as any);
    return contract(purpose, { oneOf: actionForms }, (plan
      ? 'answer.question is the plan-question id. answer.value is the attempt end declared by question.schema, with discoveryClaims.schema for submitted claims; citations must be an explicit empty array on a plan answer. Refused/impossible/duplicate ends retain their exact grounds; do not treat schema-only delivery as evidence. '
      : 'answer.value must satisfy the current question.schema; citations name exact original Sources. ') +
      (purpose === 'reading-planner'
        ? 'read_plan has 1..16 permitted reads; synthesize names the same question. pause explains why planning cannot proceed. '
        : 'need_owner requires actual searched records and unavailable owner-only information. An uncited checkpoint needs substantive proposed content or unresolved questions. On incomplete pages checkpoint/read_context before a final answer. ') +
      (synthesizing
        ? 'Synthesis accepts only answer, checkpoint, read_context, need_research, need_owner and pause. Do not search or schedule source/web reads here; need_research returns the missing material to the ordinary research route. '
        : purpose === 'reading-planner' ? ''
          : 'Deep research keeps the exact deepCell/deepScope and uses the same plan answer forms. Web search is navigation; fetch an allowed result URL, then read the saved Source before citing it. No web capability is granted by this description.'));
  }
  return null;
}

/** Supplement only the abstract addresses and semantic dependencies of the already delivered D7 schemas. */
export function finalResponseContract(assessment: boolean) {
  return contract(assessment ? 'discovery-final-assessment' : 'discovery-final', { $defs: { ...defs, claim },
    oneOf: [readContext] },
    (assessment ? 'The terminal reply follows schema, with no action wrapper. Each claim/unknown address uses the complete claim shape in $defs. All addresses resolve in the exact candidate/dossier: candidate is an existing JSON pointer (empty means whole bundle), record is an exact saved Ref, claim/unknown belong to the packet, partialReason is a zero-based existing reason, axis/contradiction name existing ids. supported requires return:null and every owner-condition class confirmed; return requires targets/reason/bases. classes preserves every owner condition id/class in candidate order; rejected class requires return. '
      : 'The terminal reply follows schema, with no action wrapper. Copy its exact subject and dossier Ref. go has no conditions; conditional has at least one; no_go/insufficient_evidence have no conditions, negative summary and explicit null projection/constitution. Conditions have unique ids. Each owner_choice offers both accept and decline with distinct optionIds; class choice must not change bounds, constitution, projection or accept new risk. Positive v9 projection identifiers and references must resolve; every unknown origin points to an exact dossier unknown or an evidence condition; grounded content quotes its exact dossier claim verbatim. ') +
    'Read all omitted exact addresses/pages before terminal reply. The only continuation action is read_context; no checkpoint is accepted here; this supplement does not replace its schema.');
}

/** Evidence-condition assessment is a separate paid purpose with its own preserved terminal schema. */
export function conditionEvidenceResponseContract() {
  return contract('discovery-condition-evidence', { oneOf: [readContext] },
    'The terminal result follows schema, without an action wrapper. Copy the exact subject. Every basis is an offered claim or {criterion:true}; supported requires return:null and at least one offered claim that fulfils the condition criterion in full. return requires a nonempty reason and needed list. The fact that a claim was accepted does not itself prove this criterion. Only read_context is a continuation; read every omitted address before returning the result.');
}

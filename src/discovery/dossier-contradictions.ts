import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import { proveClaimAddress, resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import type { Store, Revision } from '../storage/store.js';
import type { DossierManifest } from './dossier-manifest.js';
import { proveAppliedAttemptClassification } from './v7-progress.js';
import { V7_ATTEMPT_KIND, V7_CLAIM_KINDS } from './v7-contracts.js';
import { readDiscoveryAssessment, directAssessmentBasis } from './research-assessment.js';
import { readAcceptedResearchAnswer, type DiscoveryDraft, type Question } from './discovery.js';
import { proveIssuedAnswer, issuedAnswerSchemaHolds } from './projection-reader.js';
import type { PaidDiscoveryAttemptsAssessment, ResearchAnswer, ResearchAssessment } from './research-model.js';

/** DR6 6.2-F (codex-omg №9189, №9412): the closed structural form of the
 * contradictions of one dossier snapshot (карта, ndisc.d6.n2 — sources disagree,
 * the dossier keeps both sides). The model proposes the incompatibility; this
 * form keeps both sides with their stated status, why they are incompatible,
 * the plan questions they bear on, whether they block, and the resolution with
 * its exact grounds. Structural only: the statuses, the grounds and the
 * completeness of the explicit contradicts/refutedBy links are proven by real
 * producers in 6.2-D; blocking against the snapshot criteria and the ban on a
 * complete snapshot are 6.3. contradicts is symmetric; refutes is directed —
 * A.refutedBy = B is sides [B, A]. */
export const DOSSIER_CONTRADICTION_RELATIONS = Object.freeze(['contradicts', 'refutes'] as const);
/** The status of a side as its classification states it; unassessed — no classification in the snapshot grounds. */
export const DOSSIER_SIDE_STATUSES = Object.freeze(['accepted', 'rejected', 'unassessed'] as const);
/** The dimensions on which two claims may differ without conflicting — a newer
 * date or version or another region or variant scope is never by itself a
 * conflict, nor a win. */
export const DOSSIER_SCOPE_DIMENSIONS = Object.freeze(['asOf', 'apiVersion', 'region', 'variants'] as const);

export interface DossierContradictionSide { claim: ClaimAddress;
  status: typeof DOSSIER_SIDE_STATUSES[number]; assessment: Ref | null }
/** open — not resolved; side — the side at holds stands, the other stays with its
 * own status; scoped — an explicitly grounded difference of one dimension, no conflict. */
export type DossierResolution = { state: 'open' }
  | { state: 'side'; holds: 0 | 1; reason: string; grounds: Ref[] }
  | { state: 'scoped'; dimension: typeof DOSSIER_SCOPE_DIMENSIONS[number]; reason: string; grounds: Ref[] };
export interface DossierContradiction { id: string; relation: typeof DOSSIER_CONTRADICTION_RELATIONS[number];
  sides: [DossierContradictionSide, DossierContradictionSide]; reason: string; planQuestionIds: string[];
  blocking: boolean; resolution: DossierResolution }
/** What the contradictions form needs from its snapshot. */
export interface DossierContradictionContext {
  /** The identity key of a claim of the snapshot axes named by its full ClaimAddress; a typed refusal at `at` otherwise. */
  axisClaim(address: unknown, at: string): string;
}

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_dossier_invalid', `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed contradiction form');
  for (const key of fields) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the contradiction form');
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Expected nonempty text');
}
function ref(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value) || !/^[a-f0-9]{64}$/.test(value.hash)) invalid(at, 'Expected an exact reference');
}
function grounds(value: unknown, at: string): void {
  if (!Array.isArray(value) || !value.length) invalid(at, 'A resolution names its exact grounds');
  value.forEach((item, i) => ref(item, `${at}.${i}`));
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate exact references');
}

/** One side: a claim of the snapshot axes by its full address with its status.
 * An unassessed side names no assessment; a classified attempt claim names the
 * exact chosen assessment; a research answer keeps its own proof route and may
 * name none. */
function side(value: unknown, at: string, context: DossierContradictionContext): string {
  shape(value, ['claim', 'status', 'assessment'], at);
  const key = context.axisClaim(value.claim, `${at}.claim`);
  if (!(DOSSIER_SIDE_STATUSES as readonly unknown[]).includes(value.status))
    invalid(`${at}.status`, `A side status is one of ${DOSSIER_SIDE_STATUSES.join(', ')}`);
  if (value.status === 'unassessed') {
    if (value.assessment !== null) invalid(`${at}.assessment`, 'An unassessed side names no assessment');
  } else if (value.assessment === null) {
    if ((value.claim as ClaimAddress).containerKind !== 'research-answer')
      invalid(`${at}.assessment`, 'A classified attempt claim names its exact chosen assessment');
  } else ref(value.assessment, `${at}.assessment`);
  return key;
}

function resolution(value: unknown, at: string, sides: DossierContradictionSide[]): void {
  if (!object(value) || !['open', 'side', 'scoped'].includes(value.state as string))
    invalid(`${at}.state`, 'A resolution is open, side or scoped');
  if (value.state === 'open') { shape(value, ['state'], at); return; }
  if (value.state === 'side') {
    shape(value, ['state', 'holds', 'reason', 'grounds'], at);
    if (value.holds !== 0 && value.holds !== 1) invalid(`${at}.holds`, 'The standing side is 0 or 1');
    if (sides[value.holds]?.status !== 'accepted') invalid(`${at}.holds`, 'Only an accepted side stands');
  } else {
    shape(value, ['state', 'dimension', 'reason', 'grounds'], at);
    if (!(DOSSIER_SCOPE_DIMENSIONS as readonly unknown[]).includes(value.dimension))
      invalid(`${at}.dimension`, `A scoped difference is one of ${DOSSIER_SCOPE_DIMENSIONS.join(', ')}`);
  }
  text(value.reason, `${at}.reason`); grounds(value.grounds, `${at}.grounds`);
}

/** The closed form of the contradictions list. Both sides are kept — an
 * unaccepted counter-argument never disappears from its entry; the standing side
 * of a resolution is an accepted one and the other keeps its status. A pair is
 * one contradiction: unordered for contradicts, directed for refutes. A scoped
 * difference is no conflict and blocks nothing. */
export function decodeDossierContradictions(value: unknown, context: DossierContradictionContext): DossierContradiction[] {
  if (!Array.isArray(value)) invalid('contradictions', 'Expected the list of contradictions');
  const ids = new Set<unknown>(), pairs = new Set<string>();
  value.forEach((entry: unknown, i: number) => {
    const at = `contradictions.${i}`;
    shape(entry, ['id', 'relation', 'sides', 'reason', 'planQuestionIds', 'blocking', 'resolution'], at);
    text(entry.id, `${at}.id`);
    if (ids.has(entry.id)) invalid(`${at}.id`, 'Each contradiction has its own id');
    ids.add(entry.id);
    if (!(DOSSIER_CONTRADICTION_RELATIONS as readonly unknown[]).includes(entry.relation))
      invalid(`${at}.relation`, `A relation is one of ${DOSSIER_CONTRADICTION_RELATIONS.join(', ')}`);
    if (!Array.isArray(entry.sides) || entry.sides.length !== 2) invalid(`${at}.sides`, 'A contradiction keeps both of its sides');
    const sides = entry.sides as unknown[];
    const keys = sides.map((item, s) => side(item, `${at}.sides.${s}`, context));
    if (keys[0] === keys[1]) invalid(`${at}.sides`, 'The two sides are different claims');
    const pair = canonical([entry.relation as string, ...(entry.relation === 'contradicts' ? [...keys].sort() : keys)]);
    if (pairs.has(pair)) invalid(`${at}.sides`, 'A pair of claims is one contradiction of its relation');
    pairs.add(pair);
    text(entry.reason, `${at}.reason`);
    const questions = entry.planQuestionIds;
    if (!Array.isArray(questions) || !questions.length) invalid(`${at}.planQuestionIds`, 'A contradiction names the plan questions it bears on');
    questions.forEach((id: unknown, q: number) => text(id, `${at}.planQuestionIds.${q}`));
    if (new Set(questions).size !== questions.length) invalid(`${at}.planQuestionIds`, 'Each plan question is named once');
    if (typeof entry.blocking !== 'boolean') invalid(`${at}.blocking`, 'A contradiction states whether it blocks the stage');
    resolution(entry.resolution, `${at}.resolution`, sides as DossierContradictionSide[]);
    if (entry.blocking && (entry.resolution as DossierResolution).state === 'scoped')
      invalid(`${at}.blocking`, 'A difference of time, version or area is no conflict and blocks nothing');
  });
  return value as DossierContradiction[];
}

/* 6.2-D: proof of the presented contradictions, not acceptance or completeness
 * of the dossier. The explicit assessment set belongs to the snapshot input;
 * it is never reconstructed by scanning current heads. */
export interface DossierClassificationGrounds { assessments: Ref[] }
export interface ProvenDossierSide extends DossierContradictionSide { application: Ref | null }
export interface ProvenDossierContradiction { contradiction: DossierContradiction;
  sides: [ProvenDossierSide, ProvenDossierSide] }

/** The exact reader supplies the already proven manifest and plan-question set.
 * This helper checks their presented evidence; it grants no dossier acceptance. */
export function checkDossierContradictionEvidence(store: Store, manifest: DossierManifest,
  planQuestions: readonly string[], input: DossierClassificationGrounds): ProvenDossierContradiction[] {
  shape(input, ['assessments'], 'grounds');
  if (!Array.isArray(input.assessments)) invalid('grounds.assessments', 'The snapshot needs an explicit assessment set');
  const seen = new Set<string>();
  for (const [i,item] of input.assessments.entries()) {
    ref(item, `grounds.assessments.${i}`);
    if (seen.has(canonical(item))) invalid(`grounds.assessments.${i}`, 'Duplicate exact assessment');
    seen.add(canonical(item));
  }
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const at = <T>(link: Ref, kind: string, field: string): Revision<T> => {
    const row = store.get<T>(link.id, link.revision);
    if (!row || row.kind !== kind || row.hash !== link.hash || !object(row.value) || hashJson(row.value as never) !== row.hash)
      invalid(field, 'The exact ground is missing, changed or of another kind');
    return row;
  };
  const addresses = new Map<string, { address: ClaimAddress; claim: Record<string, unknown>; field: string }>();
  for (const [axis, entry] of Object.entries(manifest.axes)) for (const [i, address] of entry.claims.entries()) {
    const field = `axes.${axis}.claims.${i}`, resolved = resolveClaimAddress(store, address);
    if (!object(resolved.claim) || !(V7_CLAIM_KINDS as readonly unknown[]).includes(resolved.claim.kind)
      || resolved.claim.axis !== axis) invalid(field, 'A known claim belongs to its stated axis');
    addresses.set(canonical(address), { address, claim: resolved.claim, field });
  }
  // Historical answers retain the common provenance interpretation of their
  // own era. This does not manufacture an attempts classification for them.
  const answers = new Map<string, ReturnType<typeof answerGround>>();
  function answerGround(answerRef: Ref) {
    at<ResearchAnswer>(answerRef, 'research-answer', 'assessment.answer');
    const own = readAcceptedResearchAnswer(store, manifest.projectId, answerRef);
    const value = own.answer.value;
    const assessment = own.assessment;
    if (assessment) at(reference(assessment), 'research-assessment', 'assessment');
    const question = assessment && isRef(assessment.value.question)
      ? at<Question>(assessment.value.question, 'question', 'assessment.question')
      : store.get<Question>(value.question);
    if (!question || question.kind !== 'question' || question.value.projectId !== manifest.projectId)
      invalid('assessment.question', 'The historical answer needs its own issued question');
    const draft = store.get<DiscoveryDraft>(question.value.draftId);
    if (!draft || draft.kind !== 'discovery-draft' || draft.value.projectId !== manifest.projectId
      || !draft.value.questions.includes(question.id)) invalid('assessment.question', 'The answer belongs to its own draft');
    const proof = proveIssuedAnswer(store, draft, {question, foreign:false, answered:true,
      answerRef, field:question.value.spec.field},
      own.answer as unknown as Revision<Record<string, unknown>>, {verifyIssuedQuestion:true});
    if (!proof.ok || proof.proof.provenance.kind !== 'research-answer')
      invalid('assessment', 'The historical answer has no research provenance');
    const p = proof.proof.provenance;
    if (!p.wellFormed || !p.independent || !p.valueMatches || !p.bindsQuestion || !p.hasObservations
      || !issuedAnswerSchemaHolds(question, proof.proof.value) || !assessment
      || !['supported','insufficient','conflicting'].includes(assessment.value.verdict))
      invalid('assessment', 'The historical classification must prove this exact answer and question');
    directAssessmentBasis(store, assessment);
    return {assessment, status:assessment.value.verdict === 'supported' ? 'accepted' as const : 'rejected' as const};
  }
  const attempts = new Map<string, Revision<PaidDiscoveryAttemptsAssessment>>();
  const historical = new Map<string, Revision<ResearchAssessment>>();
  for (const [i, link] of input.assessments.entries()) {
    const field = `grounds.assessments.${i}`;
    try {
      const row = store.get(link.id, link.revision);
      if (!row || row.hash !== link.hash || !object(row.value) || row.value.projectId !== manifest.projectId
        || hashJson(row.value as never) !== row.hash) invalid(field, 'The exact assessment is missing, malformed, foreign or changed');
      if (row.kind === 'discovery-assessment') attempts.set(canonical(link), readDiscoveryAssessment(store, manifest.projectId, link));
      else if (row.kind === 'research-assessment') {
        // Use its answer's own historical reader. A set may also name an
        // unrelated historical answer: the exact issued question's successor
        // fixes that answer without scanning today's heads.
        const candidates = [...addresses.values()].filter(item => item.address.containerKind === 'research-answer'
          && same((resolveClaimAddress(store, item.address).container.value as unknown as ResearchAnswer).assessment, link));
        const links = candidates.map(candidate => candidate.address.container);
        if (!links.length) {
          const assessment = at<ResearchAssessment>(link, 'research-assessment', field);
          if (!isRef(assessment.value.question)) invalid(field, 'A historical assessment names its exact issued question');
          const issued = at<Question>(assessment.value.question, 'question', field);
          const next = store.get<Question>(issued.id, issued.revision + 1);
          if (!next || next.kind !== 'question' || !object(next.value) || !isRef(next.value.answer))
            invalid(field, 'The historical assessment has no exact saved answer to prove its origin');
          links.push(next.value.answer);
        }
        for (const answerRef of links) {
          const proof = answerGround(answerRef);
          if (!same(reference(proof.assessment), link)) invalid(field, 'The answer has another historical assessment');
          historical.set(canonical(link), proof.assessment);
          for (const candidate of candidates) if (same(candidate.address.container, answerRef))
            answers.set(canonical(candidate.address), proof);
        }
      } else invalid(field, 'Only proven attempts assessments and historical answer assessments are supported');
    } catch (error) {
      if (!(error instanceof EngineError) || error.code === 'discovery_dossier_invalid') throw error;
      throw new EngineError('discovery_dossier_invalid', `[${field}] The exact assessment is not provable: ${error.message}`,
        {field, ref:link, cause:error.code});
    }
  }
  const selected = (address: ClaimAddress) => [...attempts.values()].filter(a =>
    [...a.value.novelty.accepted, ...a.value.novelty.rejected].some(c => same(c.claim, address)));
  const evidence = new Map<string, { assessment: Ref | null; application: Ref | null; status: 'accepted'|'rejected' }>();
  function proveSide(side: DossierContradictionSide, field: string): ProvenDossierSide {
    const key = canonical(side.claim);
    if (side.status === 'unassessed') {
      const answer = side.claim.containerKind === 'research-answer'
        ? resolveClaimAddress(store, side.claim).container.value as unknown as ResearchAnswer : null;
      const classified = answer ? historical.has(canonical(answer.assessment)) : selected(side.claim).length > 0;
      if (classified) invalid(`${field}.status`, 'The exact claim is classified in the presented snapshot grounds');
      return {...side, application:null};
    }
    if (side.assessment !== null && !seen.has(canonical(side.assessment)))
      invalid(`${field}.assessment`, 'The side assessment is not in the exact snapshot set');
    let origin: {assessment: Ref|null; application:Ref|null; status:'accepted'|'rejected'};
    if (side.claim.containerKind === V7_ATTEMPT_KIND) {
      const proof = proveAppliedAttemptClassification(store, side.claim);
      origin = {assessment:reference(proof.assessment), application:reference(proof.application), status:proof.status};
      if (!same(side.assessment, origin.assessment)) invalid(`${field}.assessment`, 'Only the original first applied assessment classifies this claim');
    } else {
      const proof = answers.get(key) ?? answerGround(side.claim.container);
      origin = {assessment:reference(proof.assessment), application:null, status:proof.status};
      if (side.assessment !== null && !same(side.assessment, origin.assessment))
        invalid(`${field}.assessment`, 'The answer keeps its original historical assessment');
    }
    if (origin.status !== side.status) invalid(`${field}.status`, 'The declared status differs from its proven classification');
    if (side.status === 'accepted') proveClaimAddress(store, side.claim);
    evidence.set(key, origin);
    return {...side, application:origin.application};
  }
  const pair = (relation: DossierContradiction['relation'], a: ClaimAddress, b: ClaimAddress) =>
    canonical([relation, ...(relation === 'contradicts' ? [canonical(a),canonical(b)].sort() : [canonical(a),canonical(b)])]);
  const declared = new Set(manifest.contradictions.map(c => pair(c.relation,c.sides[0].claim,c.sides[1].claim)));
  for (const item of addresses.values()) for (const link of ['contradicts','refutedBy'] as const) {
    const targets = item.claim[link];
    if (targets === undefined) continue;
    if (!Array.isArray(targets)) invalid(`${item.field}.${link}`, 'An explicit claim relation is a list of full addresses');
    for (const [i,target] of targets.entries()) {
      const field = `${item.field}.${link}.${i}`, other = addresses.get(canonical(target));
      if (!other || same(item.address,other.address)) invalid(field, 'Every explicit relation keeps its distinct exact target inside the axes');
      const key = link === 'contradicts' ? pair('contradicts',item.address,other.address) : pair('refutes',other.address,item.address);
      if (!declared.has(key)) invalid(field, 'The snapshot omitted this explicit claim relation or reversed its direction');
    }
  }
  return manifest.contradictions.map((c,i) => {
    const field = `contradictions.${i}`;
    for (const [j,id] of c.planQuestionIds.entries()) if (!planQuestions.includes(id))
      invalid(`${field}.planQuestionIds.${j}`, 'The contradiction names a question of the exact accepted plan');
    const sides = c.sides.map((s,j) => proveSide(s, `${field}.sides.${j}`)) as [ProvenDossierSide,ProvenDossierSide];
    const resolution = c.resolution;
    if (resolution.state !== 'open') {
      const covered = new Set<number>();
      for (const [j,link] of resolution.grounds.entries()) {
        const atField = `${field}.resolution.grounds.${j}`, row = store.get(link.id,link.revision);
        if (!row || row.hash !== link.hash || hashJson(row.value as never) !== row.hash) invalid(atField, 'The exact resolution ground is missing or changed');
        let related = false;
        for (const [k,side] of sides.entries()) {
          const origin = evidence.get(canonical(side.claim));
          if (['discovery-assessment','research-assessment'].includes(row.kind)) {
            if (origin?.assessment && same(origin.assessment,link) && seen.has(canonical(link))) {covered.add(k);related=true;}
          } else if ([V7_ATTEMPT_KIND,'research-answer'].includes(row.kind) && side.status === 'accepted'
            && same(side.claim.container,link)) {
            proveClaimAddress(store,side.claim);covered.add(k);related=true;
          }
        }
        if (!related) invalid(atField, 'A supported ground proves a presented side through its original assessment or accepted claim container');
      }
      if (resolution.state === 'side') {
        if (sides[resolution.holds].status !== 'accepted' || !covered.has(resolution.holds))
          invalid(`${field}.resolution.holds`, 'The standing side needs acceptance and its own proven resolution ground');
      } else {
        const scopes = sides.map(s => addresses.get(canonical(s.claim))!.claim.scope);
        if (!covered.has(0) || !covered.has(1) || !scopes.every(object)
          || scopes.some(s => s[resolution.dimension] === undefined)
          || same(scopes[0]![resolution.dimension],scopes[1]![resolution.dimension]))
          invalid(`${field}.resolution.dimension`, 'A scoped classification names a real difference and proven grounds of both retained sides');
      }
    }
    return {contradiction:c,sides};
  });
}

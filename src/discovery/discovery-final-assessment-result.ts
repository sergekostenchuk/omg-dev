import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import type { ClaimAddress } from './claim-address.js';
import { checkV7Final, type V7FinalBundle } from './v7-final-contracts.js';
import { requireDiscoveryFinalAssessmentSubject,
  type DiscoveryFinalAssessmentPacket, type DiscoveryFinalAssessmentSubject } from './discovery-final-assessment-subject.js';

/** DR7 7a.3 (codex-omg2 №15478): the closed answer of the independent D7 assessor over one exact prepared
 * assessment subject — the complete V7FinalBundle candidate and the complete re-proven final packet (map
 * ndisc.d7.n5: is the verdict grounded, do the projection and the constitution reflect the dossier, measured
 * against the verbatim assignment; a grounded no_go passes; an ungrounded bundle returns to the summary).
 *
 * The assessor's verdict is supported or an addressed return, never one of the D7 outcomes: supported may be
 * the judgement of a lawful negative bundle, and the D7 outcome stays the candidate's own. Every answer states
 * its reasons and bases; a return names the exact places it sends back — in the candidate, by JSON pointer,
 * or among the proven grounds of its packet. The code does not judge meaning. A structural answer is not paid
 * or accepted: no call, assessment, session, application or manifest is made here. */
export const DISCOVERY_FINAL_ASSESSMENT_RESULT = 'discovery-final-assessment-result/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_PROJECTION = 'discovery-final-assessment-projection/v1' as const;

/** One exact place of the assessed material: a location in the candidate, a proven record of its grounds, a
 * dossier claim or unknown, a contradiction, a partial-dossier reason or a dossier axis. */
export type DiscoveryFinalAssessmentAddress = { candidate: string } | { record: Ref } | { claim: ClaimAddress }
  | { unknown: ClaimAddress } | { contradiction: string } | { partialReason: number } | { axis: string };
export interface DiscoveryFinalAssessmentResult {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_RESULT;
  subject: DiscoveryFinalAssessmentSubject;
  verdict: 'supported' | 'return';
  reasons: string[];
  bases: DiscoveryFinalAssessmentAddress[];
  return: null | { targets: DiscoveryFinalAssessmentAddress[]; reason: string; bases: DiscoveryFinalAssessmentAddress[] };
}
export interface DiscoveryFinalAssessmentProjection {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_PROJECTION;
  identity: string;
  subject: DiscoveryFinalAssessmentSubject;
  /** The D7 outcome stays the candidate's own; the assessor's verdict is beside it, never in its place. */
  candidateOutcome: V7FinalBundle['verdict']['outcome'];
  verdict: DiscoveryFinalAssessmentResult['verdict'];
  candidate: V7FinalBundle;
  packet: DiscoveryFinalAssessmentPacket;
  result: DiscoveryFinalAssessmentResult;
}

function invalid(field: string, message: string, code = 'discovery_final_assessment_result_invalid'): never {
  throw new EngineError(code, `[${field}] ${message}`, { field });
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!object(value)) invalid(at, 'Expected an object of the closed form');
  for (const field of fields) if (!Object.hasOwn(value, field)) invalid(`${at}.${field}`, 'The field is part of the form and is missing');
  for (const field of Object.keys(value)) if (!fields.includes(field)) invalid(`${at}.${field}`, 'The field is not part of the form');
}
function text(value: unknown, at: string): void {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'A nonempty reason is required');
}
function list(value: unknown, at: string, minimum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum) invalid(at, minimum ? 'A nonempty explicit list is required' : 'An explicit list is required');
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate entries');
}

/** RFC 6901: the pointer resolves to an existing place of the exact candidate; "" is the whole bundle. */
function pointsInto(value: unknown, pointer: string): boolean {
  if (pointer === '') return true;
  if (!pointer.startsWith('/')) return false;
  let at: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return false;
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(at)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token) || Number(token) >= at.length) return false;
      at = at[Number(token)];
    } else if (object(at) && Object.hasOwn(at, token)) at = at[token];
    else return false;
  }
  return true;
}

/** The exact places of one proven packet: its candidate, every record its final subject and dossier were proven
 * from, the dossier's materials, unknowns, contradictions with both sides, partial reasons and axes. */
function places(packet: DiscoveryFinalAssessmentPacket) {
  const records = new Set<string>();
  const add = (ref: unknown) => { if (isRef(ref)) records.add(canonical(ref)); };
  const final = packet.final, dossier = final.dossier;
  const { brief, ...basis } = final.subject.basis;
  Object.values(basis).forEach(add);
  [brief.question, brief.fact, brief.acceptance, brief.source].forEach(add);
  const recordOf = (row: { ref: Ref } | null) => { if (row) add(row.ref); };
  [dossier.root, dossier.manifest, ...Object.values(dossier.basis), ...Object.values(dossier.route), ...dossier.grounds].forEach(recordOf);
  for (const material of dossier.materials) { recordOf(material.container); recordOf(material.assessment); }
  for (const relation of dossier.contradictions) {
    relation.grounds.forEach(recordOf);
    for (const side of relation.sides) { recordOf(side.container); recordOf(side.assessment); add(side.application); }
  }
  const claims = new Set([...dossier.materials, ...dossier.contradictions.flatMap(relation => relation.sides)]
    .map(material => canonical(material.address)));
  const unknowns = new Set(dossier.unknowns.map(row => canonical(row.unknown.claim)));
  const contradictions = new Set(dossier.contradictions.map(relation => relation.contradiction.id));
  const manifest = dossier.manifest.value as { reasons?: unknown[]; axes?: Record<string, unknown> };
  return { records, claims, unknowns, contradictions, reasons: Array.isArray(manifest.reasons) ? manifest.reasons.length : 0,
    axes: object(manifest.axes) ? manifest.axes : {} };
}
function addresses(value: unknown, at: string, packet: DiscoveryFinalAssessmentPacket, known: ReturnType<typeof places>): void {
  list(value, at, 1);
  value.forEach((entry, index) => {
    const field = `${at}.${index}`;
    if (!object(entry) || Object.keys(entry).length !== 1) invalid(field, 'An address names exactly one place');
    const kind = Object.keys(entry)[0]!, place = entry[kind];
    const found = kind === 'candidate' ? typeof place === 'string' && pointsInto(packet.candidate, place)
      : kind === 'record' ? isRef(place) && Object.keys(place).length === 3 && known.records.has(canonical(place))
      : kind === 'claim' ? known.claims.has(canonical(place))
      : kind === 'unknown' ? known.unknowns.has(canonical(place))
      : kind === 'contradiction' ? typeof place === 'string' && known.contradictions.has(place)
      : kind === 'partialReason' ? Number.isSafeInteger(place) && (place as number) >= 0 && (place as number) < known.reasons
      : kind === 'axis' ? typeof place === 'string' && Object.hasOwn(known.axes, place)
      : invalid(field, 'Unknown address kind');
    if (!found) invalid(field, 'The address is no place of this exact candidate or its proven grounds');
  });
}

/** The pure checks of a proven packet's own consistency: the packet's candidate is the subject's, by form. */
function provenPacket(packet: DiscoveryFinalAssessmentPacket): void {
  if (!object(packet) || !object(packet.subject) || !object(packet.final))
    invalid('packet', 'A final assessment answer is read only against its proven packet');
  if (canonical(checkV7Final(packet.candidate)) !== canonical(packet.subject.candidate))
    invalid('packet.candidate', 'The packet candidate is not its subject\'s exact candidate');
}

/** The one closed decoder of the assessor's answer. The packet comes from the accepted final-assessment subject
 * readers; the decoder compares the whole subject and checks every address against that packet only. */
export function decodeDiscoveryFinalAssessmentResult(value: unknown, packet: DiscoveryFinalAssessmentPacket): DiscoveryFinalAssessmentResult {
  provenPacket(packet);
  // One plain JSON snapshot is read once and checked: a cycle or foreign prototype refuses, and an accessor or
  // Proxy that would answer differently on a second read is never consulted again.
  let input: unknown;
  try { input = JSON.parse(canonical(value)); } catch { invalid('result', 'The answer is not a plain JSON value'); }
  shape(input, ['contract', 'subject', 'verdict', 'reasons', 'bases', 'return'], 'result');
  if (input.contract !== DISCOVERY_FINAL_ASSESSMENT_RESULT)
    invalid('contract', `Only ${DISCOVERY_FINAL_ASSESSMENT_RESULT} is a known final assessment answer`);
  if (canonical(input.subject) !== canonical(packet.subject))
    invalid('subject', 'The answer names another or an incomplete final assessment subject', 'discovery_final_assessment_mismatch');
  if (input.verdict !== 'supported' && input.verdict !== 'return')
    invalid('verdict', 'The assessor answers supported or an addressed return');
  list(input.reasons, 'reasons', 1);
  input.reasons.forEach((reason, index) => text(reason, `reasons.${index}`));
  const known = places(packet);
  addresses(input.bases, 'bases', packet, known);
  if (input.verdict === 'supported') {
    if (input.return !== null) invalid('return', 'A supported answer has no return');
  } else {
    shape(input.return, ['targets', 'reason', 'bases'], 'return');
    text(input.return.reason, 'return.reason');
    addresses(input.return.targets, 'return.targets', packet, known);
    addresses(input.return.bases, 'return.bases', packet, known);
  }
  return input as unknown as DiscoveryFinalAssessmentResult;
}

/** Pure shared projection for the later application and paid reader. Its inputs are proven elsewhere; it reads
 * no Store and no head, and it keeps the whole candidate and the whole packet — assignment, paid D6, material,
 * unknowns, partial reasons and both sides of every contradiction. */
export function projectDiscoveryFinalAssessment(input: { packet: DiscoveryFinalAssessmentPacket; result: unknown }): DiscoveryFinalAssessmentProjection {
  const result = decodeDiscoveryFinalAssessmentResult(input.result, input.packet);
  const value = { contract: DISCOVERY_FINAL_ASSESSMENT_PROJECTION, subject: input.packet.subject,
    candidateOutcome: input.packet.candidate.verdict.outcome, verdict: result.verdict, candidate: input.packet.candidate,
    packet: input.packet, result };
  return structuredClone({ ...value, identity: `discovery-final-assessment-projection:${hashJson(value as unknown as Json)}` });
}

/** The read-only checked door: proves the whole assessment packet again from the saved grounds through the
 * accepted subject reader, then projects the answer against it. No caller resolver and no write. */
export async function checkDiscoveryFinalAssessmentResult(store: Store, project: string, subject: unknown,
  result: unknown): Promise<DiscoveryFinalAssessmentProjection> {
  const packet = await requireDiscoveryFinalAssessmentSubject(store, project, subject);
  return projectDiscoveryFinalAssessment({ packet, result });
}

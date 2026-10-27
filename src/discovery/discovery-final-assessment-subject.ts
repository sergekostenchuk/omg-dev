import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { Store } from '../storage/store.js';
import { checkFinalBundle, type V7FinalBundle } from './v7-final-contracts.js';
import { prepareDiscoveryFinalSubject, requireDiscoveryFinalSubject,
  type DiscoveryFinalPacket, type DiscoveryFinalSubject } from './discovery-final.js';

/** DR7 7a.3 (codex-omg №15332): the read-only prepared subject of the D7 final
 * assessment — the complete V7FinalBundle candidate bound to the complete
 * proven DiscoveryFinalSubject, and the packet carrying the candidate plus the
 * fully re-proven DiscoveryFinalPacket (the original mandate with provenance,
 * the whole dossier inventory, the terminal paid D6, unknowns, partial reasons
 * and both sides of contradictions). The candidate is checked by form only:
 * its verdict is preserved, never rewritten — a supported D6 does not become a
 * go and a return does not become a no_go. Preparation assigns no supported,
 * paid or accepted mark, presents the candidate as no saved producer result,
 * and pays/publishes nothing; delivery, capacity, the assessment session and
 * the paid 7a.4 evaluation remain later wiring. */
export const DISCOVERY_FINAL_ASSESSMENT_SUBJECT = 'discovery-final-assessment-subject/v1' as const;
export const DISCOVERY_FINAL_ASSESSMENT_PACKET = 'discovery-final-assessment-packet/v1' as const;
export interface DiscoveryFinalAssessmentSubject {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_SUBJECT; kind: 'final-assessment'; identity: string;
  projectId: string; candidate: V7FinalBundle; subject: DiscoveryFinalSubject;
}
export interface DiscoveryFinalAssessmentPacket {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_PACKET;
  subject: DiscoveryFinalAssessmentSubject; candidate: V7FinalBundle; final: DiscoveryFinalPacket;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(field: string, message: string, code = 'discovery_final_assessment_invalid'): never {
  throw new EngineError(code, `[${field}] ${message}`, { field });
}
function shape(value: unknown, keys: readonly string[], at: string): asserts value is Record<string, any> {
  if (!object(value)) invalid(at, 'Expected an object of the closed form');
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${at}.${key}`, 'The field is part of the form and is missing');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${at}.${key}`, 'The field is not part of the form');
}
function exactRef(value: unknown, at: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], at);
  if (!isRef(value)) invalid(at, 'An exact non-null final ground is required');
}
/** The identity derives from the version, the project and every bound value —
 * never trusted from caller input. */
function identity(basis: Omit<DiscoveryFinalAssessmentSubject, 'identity'>) {
  return `discovery-final-assessment:${hashJson(basis as unknown as Json)}`;
}
function assemble(project: string, candidate: V7FinalBundle,
  packet: DiscoveryFinalPacket): DiscoveryFinalAssessmentPacket {
  const base: Omit<DiscoveryFinalAssessmentSubject, 'identity'> = {
    contract: DISCOVERY_FINAL_ASSESSMENT_SUBJECT, kind: 'final-assessment', projectId: project,
    candidate, subject: packet.subject };
  const subject: DiscoveryFinalAssessmentSubject = { ...base, identity: identity(base) };
  return structuredClone({ contract: DISCOVERY_FINAL_ASSESSMENT_PACKET,
    subject, candidate, final: packet }) as DiscoveryFinalAssessmentPacket;
}
/** The closed subject form: the full candidate and the full final subject, and
 * an identity the caller cannot pick shorter or substitute. The candidate form
 * is checked only by the D7 form of its own version — its refusal is the form's own. */
function decodeSubject(input: unknown): DiscoveryFinalAssessmentSubject {
  shape(input, ['contract', 'kind', 'identity', 'projectId', 'candidate', 'subject'], 'subject');
  if (input.contract !== DISCOVERY_FINAL_ASSESSMENT_SUBJECT)
    invalid('contract', `Only ${DISCOVERY_FINAL_ASSESSMENT_SUBJECT} is a known final assessment subject`);
  if (input.kind !== 'final-assessment') invalid('kind', 'Only a final-assessment subject is read here');
  if (typeof input.projectId !== 'string' || !input.projectId.length)
    invalid('projectId', 'A final assessment subject needs its project');
  const candidate = checkFinalBundle(input.candidate);
  const { identity: presented, ...basis } = input;
  const expected = { ...basis, candidate };
  if (presented !== identity(expected as Omit<DiscoveryFinalAssessmentSubject, 'identity'>))
    invalid('identity', 'The final assessment identity differs from its bound content',
      'discovery_final_assessment_mismatch');
  return structuredClone({ ...expected, identity: presented }) as DiscoveryFinalAssessmentSubject;
}
/** The candidate names the exact dossier snapshot of the proven packet — a
 * manifest Ref of another dossier is a foreign candidate. */
function bindDossier(candidate: V7FinalBundle, packet: DiscoveryFinalPacket): void {
  if (!same(candidate.dossier, packet.dossier.manifest.ref))
    invalid('dossier', 'The candidate dossier is not the exact manifest of the proven packet',
      'discovery_final_assessment_mismatch');
}

/** Read-only D7 assessment input: proves the exact paid D6 once through the
 * shared final subject, form-checks the complete candidate and binds both. */
export async function prepareDiscoveryFinalAssessmentSubject(store: Store, project: string,
  assessmentRef: unknown, candidate: unknown): Promise<DiscoveryFinalAssessmentPacket> {
  if (typeof project !== 'string' || !project.length)
    invalid('projectId', 'A final assessment subject needs its project');
  exactRef(assessmentRef, 'assessment');
  const checked = checkFinalBundle(candidate);
  const packet = await prepareDiscoveryFinalSubject(store, project, assessmentRef);
  bindDossier(checked, packet);
  return assemble(project, checked, packet);
}
/** Re-proves the saved grounds and compares the whole presented subject; a
 * caller-recomputed identity never replaces that proof. */
export async function requireDiscoveryFinalAssessmentSubject(store: Store, project: string,
  input: unknown): Promise<DiscoveryFinalAssessmentPacket> {
  const subject = decodeSubject(input);
  if (subject.projectId !== project)
    invalid('projectId', 'The final assessment subject belongs to another project',
      'discovery_final_assessment_mismatch');
  const packet = await requireDiscoveryFinalSubject(store, project, subject.subject);
  bindDossier(subject.candidate, packet);
  const expected = assemble(project, subject.candidate, packet);
  if (!same(subject, expected.subject))
    invalid('subject', 'The final assessment subject differs from its proven saved input',
      'discovery_final_assessment_mismatch');
  return expected;
}
export async function requireDiscoveryFinalAssessmentPacket(store: Store, project: string,
  input: unknown): Promise<DiscoveryFinalAssessmentPacket> {
  shape(input, ['contract', 'subject', 'candidate', 'final'], 'packet');
  if (input.contract !== DISCOVERY_FINAL_ASSESSMENT_PACKET)
    invalid('contract', `Only ${DISCOVERY_FINAL_ASSESSMENT_PACKET} is a known final assessment packet`);
  const packet = await requireDiscoveryFinalAssessmentSubject(store, project, input.subject);
  if (!same(input, packet))
    invalid('packet', 'The final assessment packet omits or substitutes bound material',
      'discovery_final_assessment_mismatch');
  return packet;
}

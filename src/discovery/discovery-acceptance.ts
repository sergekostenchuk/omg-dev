import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, Write } from '../storage/store.js';
import { readProjectMode, type ProjectModeStatus } from '../product/project-mode.js';
import { readDiscoveryFinalAssessmentPaidResultAt } from './discovery-final-assessment-execution.js';
import type { DiscoveryFinalAssessmentSource } from './discovery-final-assessment-source.js';
import { DISCOVERY_MANIFEST_CONTRACT, DISCOVERY_MANIFEST_KIND, discoveryManifestId, readDiscoveryManifestStructural,
  type DiscoveryManifest } from './discovery-manifest.js';
import { checkV7Final, type V7FinalBundle } from './v7-final-contracts.js';

/** DR7 7b.1+7b.2 (codex-omg2 №16106 п.1): the authoritative decision on one exact assessed D7 bundle and the atomic
 * publication of its accepted manifest (map ndisc.d7.n6). Only the whole bundle of a really paid assessment with the
 * verdict supported is acceptable; supported changes no D7 outcome and fulfils no condition. In questions mode the owner
 * decides through a separate scoped authority on the project, the exact draft, the bundle and the assessment — no other
 * owner authority stands for it — and a refusal publishes nothing accepted. In bypass mode the code writes a machine
 * admission from the proven saved project policy; it is no owner signature. Without a mode there is no acceptance.
 *
 * The saved forms and their historical proofs live here, so that the reader of an accepted Discovery proves the
 * owner branch without importing the authority module; the unforgeable authority and the single producer live in
 * product/owner-authority.ts. The first acceptance has previous=null and no resolutions; 7b.3 adds proven transitions. */
export const FINAL_ACCEPTANCE_ACTION = 'discovery-final-acceptance' as const;
export const FINAL_ACCEPTANCE_PAIRING_METHOD = 'local-pairing/v1' as const;
export const FINAL_ACCEPTANCE_GRANT_CONTRACT = 'owner-session-grant/v6' as const;
export const FINAL_ACCEPTANCE_SESSION_CONTRACT = 'owner-session/v6' as const;
export const FINAL_ACCEPTANCE_GRANT_PREFIX = 'owner-final-acceptance-grant:';
export const FINAL_ACCEPTANCE_SESSION_PREFIX = 'owner-final-acceptance-session:';
export const FINAL_ACCEPTANCE_GRANT_KIND = 'owner-session-grant';
export const FINAL_ACCEPTANCE_SESSION_KIND = 'owner-session';
export const FINAL_ACCEPTANCE_GRANT_LIFETIME_MS = 10 * 60_000;
export const FINAL_ACCEPTANCE_SESSION_LIFETIME_MS = 30 * 60_000;
export const FINAL_ACCEPTANCE_ACT_KIND = 'discovery-final-acceptance-act' as const;
export const FINAL_ACCEPTANCE_ACT_CONTRACT = 'discovery-final-acceptance-act/v1' as const;
export const FINAL_MACHINE_ADMISSION_KIND = 'discovery-final-machine-admission' as const;
export const FINAL_MACHINE_ADMISSION_CONTRACT = 'discovery-final-machine-admission/v1' as const;
export const ACCEPTED_FINAL_BUNDLE_KIND = 'discovery-final-bundle' as const;
export const ACCEPTED_FINAL_BUNDLE_CONTRACT = 'discovery-final-bundle/v1' as const;

/** One exact owner decision: the project, the D7 draft, the paid D7 result, its paid assessment, the questions-mode
 * record it is made under, accept or decline, and the owner's reason. */
export interface FinalAcceptanceScope {
  projectId: string; draft: Ref; paid: Ref; assessment: Ref; mode: Ref; decision: 'accept' | 'decline'; reason: string;
}
export interface FinalAcceptanceSessionGrant {
  contract: typeof FINAL_ACCEPTANCE_GRANT_CONTRACT; id: string; database: string; action: typeof FINAL_ACCEPTANCE_ACTION;
  method: typeof FINAL_ACCEPTANCE_PAIRING_METHOD; scope: FinalAcceptanceScope; issuedAt: number; expiresAt: number; proof: string;
}
export interface FinalAcceptanceSession {
  contract: typeof FINAL_ACCEPTANCE_SESSION_CONTRACT; grant: Ref; database: string; action: typeof FINAL_ACCEPTANCE_ACTION;
  method: typeof FINAL_ACCEPTANCE_PAIRING_METHOD; scope: FinalAcceptanceScope; session: string; openedAt: number; expiresAt: number;
  state: 'open' | 'closed'; closedAt?: number;
}
/** The saved owner act: its exact scope and the exact open session (and grant) that authorized it. */
export interface FinalAcceptanceAct {
  contract: typeof FINAL_ACCEPTANCE_ACT_CONTRACT; database: string; projectId: string; scope: FinalAcceptanceScope;
  authority: { grant: Ref; session: Ref }; at: number;
}
/** The saved machine admission of bypass mode: the exact proven bypass record is its whole authority. */
export interface FinalMachineAdmission {
  contract: typeof FINAL_MACHINE_ADMISSION_CONTRACT; database: string; projectId: string;
  draft: Ref; paid: Ref; assessment: Ref; mode: Ref; policy: 'bypass';
}
/** The one saved record of the whole accepted D7 bundle, bound to its paid D7 result. */
export interface AcceptedFinalBundle { contract: typeof ACCEPTED_FINAL_BUNDLE_CONTRACT; projectId: string; paid: Ref; bundle: V7FinalBundle }

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []) =>
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const same = (left: unknown, right: unknown) => canonical(left as never) === canonical(right as never);
const exact = (ref: Ref): Ref => ({ id: ref.id, revision: ref.revision, hash: ref.hash });
const exactRef = (value: unknown): value is Ref => isRef(value) && plain(value) && exactKeys(value, ['id', 'revision', 'hash']);
function acceptanceInvalid(field: string, message: string, details: Record<string, unknown> = {},
  code = 'discovery_acceptance_invalid'): never {
  throw new EngineError(code, `[${field}] ${message}`, { field, ...details });
}
/** One plain JSON snapshot of a caller value, read once. */
export function acceptanceSnapshot(value: unknown, field: string): unknown {
  try { return JSON.parse(canonical(value as never)); }
  catch { return acceptanceInvalid(field, 'Expected a plain JSON value'); }
}

export function requireFinalAcceptanceScope(value: unknown): FinalAcceptanceScope {
  if (!plain(value) || !exactKeys(value, ['projectId', 'draft', 'paid', 'assessment', 'mode', 'decision', 'reason'])
    || !text(value.projectId) || !exactRef(value.draft) || !exactRef(value.paid) || !exactRef(value.assessment) || !exactRef(value.mode)
    || (value.decision !== 'accept' && value.decision !== 'decline') || !text(value.reason))
    acceptanceInvalid('scope', 'An acceptance names the project, the exact draft, paid D7, paid assessment and questions-mode record, accept or decline and a reason only');
  return { projectId: value.projectId as string, draft: exact(value.draft as Ref), paid: exact(value.paid as Ref),
    assessment: exact(value.assessment as Ref), mode: exact(value.mode as Ref), decision: value.decision as 'accept' | 'decline',
    reason: value.reason as string };
}
export function finalAcceptanceSessionId(grant: Ref): string {
  return `${FINAL_ACCEPTANCE_SESSION_PREFIX}${hashJson(exact(grant) as never)}`;
}
/** One decision per paid assessment: its act or its machine admission has one address. */
export const finalAcceptanceActId = (projectId: string, assessment: Ref) =>
  `${FINAL_ACCEPTANCE_ACT_KIND}:${projectId}:${hashJson(exact(assessment) as never)}`;
export const finalMachineAdmissionId = (projectId: string, assessment: Ref) =>
  `${FINAL_MACHINE_ADMISSION_KIND}:${projectId}:${hashJson(exact(assessment) as never)}`;
export const acceptedFinalBundleId = (value: AcceptedFinalBundle) =>
  `${ACCEPTED_FINAL_BUNDLE_KIND}:${value.projectId}:${hashJson(value as unknown as Json)}`;

function exactRecord<T>(store: Store, ref: unknown, kind: string, prefix: string, field: string): Revision<T> {
  if (!exactRef(ref) || !ref.id.startsWith(prefix)) acceptanceInvalid(field, `Expected the exact ${field} record`);
  const row = store.get<T>(ref.id, ref.revision);
  // ACCEPTANCE-EXACT-REF-01: the answered row is the referenced address itself — its id, revision and hash.
  if (!row || row.kind !== kind || !same(reference(row), ref) || row.hash !== hashJson(row.value as never) || !plain(row.value))
    acceptanceInvalid(field, `The exact ${field} record is not stored as referenced`, { ref });
  return row;
}
/** Historical proof of one exact v6 grant: its complete closed provenance. */
export function readFinalAcceptanceGrant(store: Store, ref: unknown): Revision<FinalAcceptanceSessionGrant> {
  const row = exactRecord<FinalAcceptanceSessionGrant>(store, ref, FINAL_ACCEPTANCE_GRANT_KIND, FINAL_ACCEPTANCE_GRANT_PREFIX, 'grant');
  const value = row.value as unknown as Record<string, unknown>;
  if (row.revision !== 1 || !exactKeys(value, ['contract', 'id', 'database', 'action', 'method', 'scope', 'issuedAt', 'expiresAt', 'proof'])
    || value.contract !== FINAL_ACCEPTANCE_GRANT_CONTRACT || value.database !== store.databaseId || !text(value.id)
    || row.id !== `${FINAL_ACCEPTANCE_GRANT_PREFIX}${value.id}` || value.action !== FINAL_ACCEPTANCE_ACTION
    || value.method !== FINAL_ACCEPTANCE_PAIRING_METHOD || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.issuedAt as number) !== FINAL_ACCEPTANCE_GRANT_LIFETIME_MS
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof))
    acceptanceInvalid('grant', 'An acceptance invitation keeps its complete v6 provenance', { ref: reference(row) });
  requireFinalAcceptanceScope(value.scope);
  return row;
}
/** Historical proof of one exact v6 session revision, open or closed. */
export function readFinalAcceptanceSession(store: Store, ref: unknown): Revision<FinalAcceptanceSession> {
  const row = exactRecord<FinalAcceptanceSession>(store, ref, FINAL_ACCEPTANCE_SESSION_KIND, FINAL_ACCEPTANCE_SESSION_PREFIX, 'session');
  const value = row.value as unknown as Record<string, unknown>;
  if (!exactKeys(value, ['contract', 'grant', 'database', 'action', 'method', 'scope', 'session', 'openedAt', 'expiresAt', 'state'], ['closedAt'])
    || value.contract !== FINAL_ACCEPTANCE_SESSION_CONTRACT || !exactRef(value.grant) || row.id !== finalAcceptanceSessionId(value.grant)
    || value.database !== store.databaseId || value.action !== FINAL_ACCEPTANCE_ACTION || value.method !== FINAL_ACCEPTANCE_PAIRING_METHOD
    || !text(value.session) || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.openedAt as number) !== FINAL_ACCEPTANCE_SESSION_LIFETIME_MS
    || (value.state !== 'open' && value.state !== 'closed') || (value.state === 'closed') !== Object.hasOwn(value, 'closedAt')
    || (value.state === 'closed' && !Number.isSafeInteger(value.closedAt))
    || (value.state === 'open' && row.revision !== 1) || (value.state === 'closed' && row.revision !== 2))
    acceptanceInvalid('session', 'An acceptance owner session keeps its complete v6 provenance', { ref: reference(row) });
  const scope = requireFinalAcceptanceScope(value.scope), grant = readFinalAcceptanceGrant(store, value.grant);
  if (!same(grant.value.scope, scope) || (value.openedAt as number) < grant.value.issuedAt || (value.openedAt as number) >= grant.value.expiresAt)
    acceptanceInvalid('session', 'An acceptance session descends from its exact scoped grant inside its saved window', { ref: reference(row) });
  if (value.state === 'closed') {
    const first = store.get<FinalAcceptanceSession>(row.id, 1);
    if (!first) acceptanceInvalid('session', 'The exact open revision of a revoked session is absent', { ref: reference(row) });
    const opened = readFinalAcceptanceSession(store, reference(first!));
    const { closedAt, ...rest } = value;
    if (!same({ ...rest, state: 'open' }, opened.value) || (closedAt as number) < (value.openedAt as number))
      acceptanceInvalid('session', 'Revocation changes only the state and closedAt of the exact open session', { ref: reference(row) });
  }
  return row;
}

/** The proven grounds of one acceptance: a really paid assessment with the verdict supported, over the exact paid D7
 * and its whole bundle; the draft is the D7 subject's own. */
export interface DiscoveryAcceptanceGrounds {
  assessment: Ref; paid: Ref; draft: Ref; bundle: V7FinalBundle; source: DiscoveryFinalAssessmentSource;
}
export async function provenAcceptanceGrounds(store: Store, project: string, assessmentRef: Ref): Promise<DiscoveryAcceptanceGrounds> {
  const proven = await readDiscoveryFinalAssessmentPaidResultAt(store, project, assessmentRef);
  if (!proven.output || !proven.result) acceptanceInvalid('assessment', 'Only a really paid assessment can be accepted');
  if (proven.result.verdict !== 'supported')
    acceptanceInvalid('assessment', 'Only an assessment with the verdict supported is acceptable; a return is not', {}, 'discovery_acceptance_not_supported');
  const source = proven.source, bundle = checkV7Final(proven.result.candidate);
  if (!same(bundle, source.bundle) || !same(proven.result.candidate, source.packet.candidate))
    acceptanceInvalid('bundle', 'The assessed bundle is not the whole bundle of its paid D7');
  return { assessment: exact(reference(proven.output)), paid: exact(reference(source.paid)),
    draft: exact(source.packet.final.subject.basis.draft), bundle, source };
}
/** The current project mode, proven; a project without one has no acceptance. */
export function provenAcceptanceMode(store: Store, project: string, at?: Ref): ProjectModeStatus {
  try { return readProjectMode(store, project, at); }
  catch (error) {
    if (error instanceof EngineError && error.code === 'project_mode_unset')
      acceptanceInvalid('mode', 'A project without a saved mode has no acceptance', {}, 'discovery_acceptance_mode_unset');
    throw error;
  }
}

/** The writes of one accepted publication: the admission record, the saved whole bundle and the manifest naming them. */
export function acceptanceWrites(project: string, grounds: DiscoveryAcceptanceGrounds,
  admission: { kind: 'owner'; act: FinalAcceptanceAct } | { kind: 'machine'; admission: FinalMachineAdmission }):
  { writes: Write[]; manifest: { id: string; revision: 1; value: DiscoveryManifest } } {
  const record = admission.kind === 'owner'
    ? { id: finalAcceptanceActId(project, grounds.assessment), kind: FINAL_ACCEPTANCE_ACT_KIND, value: admission.act }
    : { id: finalMachineAdmissionId(project, grounds.assessment), kind: FINAL_MACHINE_ADMISSION_KIND, value: admission.admission };
  const bundle: AcceptedFinalBundle = { contract: ACCEPTED_FINAL_BUNDLE_CONTRACT, projectId: project, paid: grounds.paid,
    bundle: structuredClone(grounds.bundle) };
  const bundleId = acceptedFinalBundleId(bundle);
  const manifest: DiscoveryManifest = { contract: DISCOVERY_MANIFEST_CONTRACT, projectId: project, draft: grounds.draft,
    bundle: { id: bundleId, revision: 1, hash: hashJson(bundle as unknown as Json) }, assessment: grounds.assessment,
    admission: { kind: admission.kind, record: { id: record.id, revision: 1, hash: hashJson(record.value as unknown as Json) } },
    previous: null, resolutions: [] };
  return { writes: [{ id: record.id, kind: record.kind, expected: 0, value: record.value },
    { id: bundleId, kind: ACCEPTED_FINAL_BUNDLE_KIND, expected: 0, value: bundle },
    { id: discoveryManifestId(manifest), kind: DISCOVERY_MANIFEST_KIND, expected: 0, value: manifest }],
  manifest: { id: discoveryManifestId(manifest), revision: 1, value: manifest } };
}

/** The saved owner act, proved from its own grounds — the exact questions-mode record, the exact open session and
 * grant inside their windows — never from a live bearer or today's heads. */
export function proveFinalAcceptanceAct(store: Store, project: string, ref: Ref, grounds: DiscoveryAcceptanceGrounds): Revision<FinalAcceptanceAct> {
  const row = exactRecord<FinalAcceptanceAct>(store, ref, FINAL_ACCEPTANCE_ACT_KIND, `${FINAL_ACCEPTANCE_ACT_KIND}:`, 'act');
  const value = row.value as unknown as Record<string, unknown>;
  if (row.revision !== 1 || row.id !== finalAcceptanceActId(project, grounds.assessment)
    || !exactKeys(value, ['contract', 'database', 'projectId', 'scope', 'authority', 'at']) || value.contract !== FINAL_ACCEPTANCE_ACT_CONTRACT
    || value.database !== store.databaseId || value.projectId !== project || !Number.isSafeInteger(value.at)
    || !plain(value.authority) || !exactKeys(value.authority, ['grant', 'session']))
    acceptanceInvalid('act', 'An owner acceptance act keeps its complete v1 provenance', { ref });
  const scope = requireFinalAcceptanceScope(value.scope);
  if (scope.projectId !== project || !same(scope.draft, grounds.draft) || !same(scope.paid, grounds.paid) || !same(scope.assessment, grounds.assessment))
    acceptanceInvalid('scope', 'The owner act names another draft, paid D7 or assessment', { ref });
  const mode = provenAcceptanceMode(store, project, scope.mode);
  if (mode.mode !== 'questions') acceptanceInvalid('mode', 'An owner act is made under its exact questions-mode record', { ref });
  const authority = value.authority as Record<string, unknown>;
  const session = readFinalAcceptanceSession(store, authority.session), grant = readFinalAcceptanceGrant(store, authority.grant);
  if (session.value.state !== 'open' || !same(session.value.grant, reference(grant)) || !same(session.value.scope, scope)
    || session.value.openedAt > (value.at as number) || (value.at as number) >= session.value.expiresAt)
    acceptanceInvalid('session', 'The owner act was authorized by its exact saved open acceptance session', { ref });
  return row;
}
/** The saved machine admission, proved from the exact bypass-mode record it names. */
export function proveFinalMachineAdmission(store: Store, project: string, ref: Ref, grounds: DiscoveryAcceptanceGrounds): Revision<FinalMachineAdmission> {
  const row = exactRecord<FinalMachineAdmission>(store, ref, FINAL_MACHINE_ADMISSION_KIND, `${FINAL_MACHINE_ADMISSION_KIND}:`, 'admission');
  const value = row.value as unknown as Record<string, unknown>;
  if (row.revision !== 1 || row.id !== finalMachineAdmissionId(project, grounds.assessment)
    || !exactKeys(value, ['contract', 'database', 'projectId', 'draft', 'paid', 'assessment', 'mode', 'policy'])
    || value.contract !== FINAL_MACHINE_ADMISSION_CONTRACT || value.database !== store.databaseId || value.projectId !== project
    || value.policy !== 'bypass' || !exactRef(value.mode) || !same(value.draft, grounds.draft) || !same(value.paid, grounds.paid)
    || !same(value.assessment, grounds.assessment))
    acceptanceInvalid('admission', 'A machine admission names exactly its draft, paid D7, assessment and bypass record', { ref });
  const mode = provenAcceptanceMode(store, project, value.mode as Ref);
  if (mode.mode !== 'bypass') acceptanceInvalid('mode', 'A machine admission stands only on a proven bypass-mode record', { ref });
  return row;
}

export interface AcceptedDiscovery {
  verification: 'accepted';
  manifest: Revision<DiscoveryManifest>;
  bundle: Revision<AcceptedFinalBundle>;
  admission: { kind: 'owner'; record: Revision<FinalAcceptanceAct> } | { kind: 'machine'; record: Revision<FinalMachineAdmission> };
  grounds: DiscoveryAcceptanceGrounds;
}
/** The historical reader of an accepted manifest: the structural record, then the paid supported assessment, the saved
 * whole bundle and the admission are proven again from their exact Refs; late heads and a cold Store change nothing. */
export async function readAcceptedDiscoveryManifestAt(store: Store, project: string, at: unknown): Promise<AcceptedDiscovery> {
  const ref = acceptanceSnapshot(at, 'manifest') as Ref;
  const structural = readDiscoveryManifestStructural(store, project, ref), manifest = structural.record;
  if (manifest.value.previous !== null || manifest.value.resolutions.length !== 0)
    acceptanceInvalid('manifest', 'A first acceptance has no previous manifest and no resolutions');
  // The saved records are read exactly before the paid assessment is proven again, so a lost or substituted record is
  // refused before that proof; every relation between them is still checked against the proven grounds below.
  const bundle = exactRecord<AcceptedFinalBundle>(store, manifest.value.bundle, ACCEPTED_FINAL_BUNDLE_KIND, `${ACCEPTED_FINAL_BUNDLE_KIND}:`, 'bundle');
  const admitted = manifest.value.admission.kind === 'owner'
    ? exactRecord<FinalAcceptanceAct>(store, manifest.value.admission.record, FINAL_ACCEPTANCE_ACT_KIND, `${FINAL_ACCEPTANCE_ACT_KIND}:`, 'act')
    : exactRecord<FinalMachineAdmission>(store, manifest.value.admission.record, FINAL_MACHINE_ADMISSION_KIND, `${FINAL_MACHINE_ADMISSION_KIND}:`, 'admission');
  if (manifest.value.admission.kind === 'owner' && (admitted.value as { scope?: { decision?: unknown } }).scope?.decision !== 'accept')
    acceptanceInvalid('act', 'A declining owner act publishes no accepted manifest');
  const grounds = await provenAcceptanceGrounds(store, project, manifest.value.assessment);
  if (!same(manifest.value.draft, grounds.draft)) acceptanceInvalid('draft', 'The manifest names another draft than its assessed D7');
  const bundleValue = bundle.value as unknown as Record<string, unknown>;
  if (bundle.revision !== 1 || !exactKeys(bundleValue, ['contract', 'projectId', 'paid', 'bundle']) || bundleValue.contract !== ACCEPTED_FINAL_BUNDLE_CONTRACT
    || bundleValue.projectId !== project || !same(bundleValue.paid, grounds.paid) || !same(bundleValue.bundle, grounds.bundle)
    || bundle.id !== acceptedFinalBundleId(bundle.value))
    acceptanceInvalid('bundle', 'The saved bundle is not the whole bundle of the assessed paid D7');
  const admission = manifest.value.admission.kind === 'owner'
    ? { kind: 'owner' as const, record: proveFinalAcceptanceAct(store, project, manifest.value.admission.record, grounds) }
    : { kind: 'machine' as const, record: proveFinalMachineAdmission(store, project, manifest.value.admission.record, grounds) };
  if (admission.kind === 'owner' && admission.record.value.scope.decision !== 'accept')
    acceptanceInvalid('act', 'A declining owner act publishes no accepted manifest');
  return structuredClone({ verification: 'accepted', manifest, bundle, admission, grounds });
}

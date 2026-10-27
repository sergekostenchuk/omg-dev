import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, Write } from '../storage/store.js';
import { readProjectMode, type ProjectModeStatus } from '../product/project-mode.js';
import { readDiscoveryFinalAssessmentPaidResultAt } from './discovery-final-assessment-execution.js';
import type { DiscoveryFinalAssessmentSource } from './discovery-final-assessment-source.js';
import { DISCOVERY_MANIFEST_CONTRACT, DISCOVERY_MANIFEST_KIND, discoveryManifestId, readDiscoveryManifestStructural,
  type DiscoveryManifest } from './discovery-manifest.js';
import { checkFinalBundle, type V7FinalBundle } from './v7-final-contracts.js';

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
  return sessionIdOf(FINAL_ACCEPTANCE_SESSION_PREFIX, grant);
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
/** The saved provenance of one kind of scoped owner session: its record kinds, contracts, prefixes, lifetimes and scope. */
interface OwnerSessionSpec<S> {
  label: string; action: string; grantContract: string; sessionContract: string; grantPrefix: string; sessionPrefix: string;
  grantLifetime: number; sessionLifetime: number; scope: (value: unknown) => S;
}
const sessionIdOf = (prefix: string, grant: Ref) => `${prefix}${hashJson(exact(grant) as never)}`;
/** Historical proof of one exact grant: its complete closed provenance. */
function readScopedGrant<G extends { scope: S; issuedAt: number; expiresAt: number }, S>(store: Store, ref: unknown,
  spec: OwnerSessionSpec<S>): Revision<G> {
  const row = exactRecord<G>(store, ref, FINAL_ACCEPTANCE_GRANT_KIND, spec.grantPrefix, 'grant');
  const value = row.value as unknown as Record<string, unknown>;
  if (row.revision !== 1 || !exactKeys(value, ['contract', 'id', 'database', 'action', 'method', 'scope', 'issuedAt', 'expiresAt', 'proof'])
    || value.contract !== spec.grantContract || value.database !== store.databaseId || !text(value.id)
    || row.id !== `${spec.grantPrefix}${value.id}` || value.action !== spec.action
    || value.method !== FINAL_ACCEPTANCE_PAIRING_METHOD || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.issuedAt as number) !== spec.grantLifetime
    || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof))
    acceptanceInvalid('grant', `An ${spec.label} invitation keeps its complete provenance`, { ref: reference(row) });
  spec.scope(value.scope);
  return row;
}
/** Historical proof of one exact session revision, open or closed. */
function readScopedSession<V extends { scope: S; grant: Ref; openedAt: number; expiresAt: number; state: 'open' | 'closed' },
  S>(store: Store, ref: unknown, spec: OwnerSessionSpec<S>): Revision<V> {
  const row = exactRecord<V>(store, ref, FINAL_ACCEPTANCE_SESSION_KIND, spec.sessionPrefix, 'session');
  const value = row.value as unknown as Record<string, unknown>;
  if (!exactKeys(value, ['contract', 'grant', 'database', 'action', 'method', 'scope', 'session', 'openedAt', 'expiresAt', 'state'], ['closedAt'])
    || value.contract !== spec.sessionContract || !exactRef(value.grant) || row.id !== sessionIdOf(spec.sessionPrefix, value.grant)
    || value.database !== store.databaseId || value.action !== spec.action || value.method !== FINAL_ACCEPTANCE_PAIRING_METHOD
    || !text(value.session) || !Number.isSafeInteger(value.openedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) - (value.openedAt as number) !== spec.sessionLifetime
    || (value.state !== 'open' && value.state !== 'closed') || (value.state === 'closed') !== Object.hasOwn(value, 'closedAt')
    || (value.state === 'closed' && !Number.isSafeInteger(value.closedAt))
    || (value.state === 'open' && row.revision !== 1) || (value.state === 'closed' && row.revision !== 2))
    acceptanceInvalid('session', `An ${spec.label} owner session keeps its complete provenance`, { ref: reference(row) });
  const scope = spec.scope(value.scope), grant = readScopedGrant<{ scope: S; issuedAt: number; expiresAt: number }, S>(store, value.grant, spec);
  if (!same(grant.value.scope, scope) || (value.openedAt as number) < grant.value.issuedAt || (value.openedAt as number) >= grant.value.expiresAt)
    acceptanceInvalid('session', `An ${spec.label} session descends from its exact scoped grant inside its saved window`, { ref: reference(row) });
  if (value.state === 'closed') {
    const first = store.get<V>(row.id, 1);
    if (!first) acceptanceInvalid('session', 'The exact open revision of a revoked session is absent', { ref: reference(row) });
    const opened = readScopedSession<V, S>(store, reference(first!), spec);
    const { closedAt, ...rest } = value;
    if (!same({ ...rest, state: 'open' }, opened.value) || (closedAt as number) < (value.openedAt as number))
      acceptanceInvalid('session', 'Revocation changes only the state and closedAt of the exact open session', { ref: reference(row) });
  }
  return row;
}
/** The saved act of one scoped owner session: authorized by its exact open session and grant, inside the session window. */
function requireActSession<S>(store: Store, authority: unknown, scope: S, at: number, spec: OwnerSessionSpec<S>, ref: Ref): void {
  if (!plain(authority) || !exactKeys(authority, ['grant', 'session']))
    acceptanceInvalid('session', `The ${spec.label} act names its exact grant and session`, { ref });
  const session = readScopedSession<{ scope: S; grant: Ref; openedAt: number; expiresAt: number; state: 'open' | 'closed' }, S>(store, authority.session, spec);
  const grant = readScopedGrant<{ scope: S; issuedAt: number; expiresAt: number }, S>(store, authority.grant, spec);
  if (session.value.state !== 'open' || !same(session.value.grant, reference(grant)) || !same(session.value.scope, scope)
    || session.value.openedAt > at || at >= session.value.expiresAt)
    acceptanceInvalid('session', `The ${spec.label} act was authorized by its exact saved open session`, { ref });
}
const FINAL_ACCEPTANCE_SPEC: OwnerSessionSpec<FinalAcceptanceScope> = { label: 'acceptance', action: FINAL_ACCEPTANCE_ACTION,
  grantContract: FINAL_ACCEPTANCE_GRANT_CONTRACT, sessionContract: FINAL_ACCEPTANCE_SESSION_CONTRACT,
  grantPrefix: FINAL_ACCEPTANCE_GRANT_PREFIX, sessionPrefix: FINAL_ACCEPTANCE_SESSION_PREFIX,
  grantLifetime: FINAL_ACCEPTANCE_GRANT_LIFETIME_MS, sessionLifetime: FINAL_ACCEPTANCE_SESSION_LIFETIME_MS, scope: requireFinalAcceptanceScope };
/** The one first revision of a record addressed by its canonical id, not by a caller Ref. */
function soleRecord<T>(store: Store, id: string, kind: string, field: string): Revision<T> {
  const row = store.get<T>(id, 1);
  if (!row || row.id !== id || row.revision !== 1 || row.kind !== kind || row.hash !== hashJson(row.value as never) || !plain(row.value))
    acceptanceInvalid(field, `The ${field} record is not stored at its canonical address`, { id });
  return row;
}
/** Historical proof of one exact v6 grant: its complete closed provenance. */
export function readFinalAcceptanceGrant(store: Store, ref: unknown): Revision<FinalAcceptanceSessionGrant> {
  return readScopedGrant<FinalAcceptanceSessionGrant, FinalAcceptanceScope>(store, ref, FINAL_ACCEPTANCE_SPEC);
}
/** Historical proof of one exact v6 session revision, open or closed. */
export function readFinalAcceptanceSession(store: Store, ref: unknown): Revision<FinalAcceptanceSession> {
  return readScopedSession<FinalAcceptanceSession, FinalAcceptanceScope>(store, ref, FINAL_ACCEPTANCE_SPEC);
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
  const source = proven.source, bundle = checkFinalBundle(proven.result.candidate);
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
  requireActSession(store, value.authority, scope, value.at as number, FINAL_ACCEPTANCE_SPEC, ref);
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
  /** DR7 7b.3: the conditions of the bundle, derived on reading. Nothing resolves a condition of this contract yet — an
   * evidence condition waits for 7b.3e, an owner choice for its proven class — so every condition stays open. */
  resolutions: Revision<ConditionResolution>[];
  conditions: { resolved: string[]; open: string[] };
}
/** The historical reader of an accepted manifest: the structural record, then the paid supported assessment, the saved
 * whole bundle and the admission are proven again from their exact Refs; late heads and a cold Store change nothing.
 * DR7 7b.3 (codex-omg2 №16169): a later edition would resolve a condition, and no owner choice of this contract has a
 * proven class (a choice inside the bundle, against a boundary or a risk), so a later edition is refused — also one
 * that names a real saved owner act as its resolution. */
export async function readAcceptedDiscoveryManifestAt(store: Store, project: string, at: unknown): Promise<AcceptedDiscovery> {
  const ref = acceptanceSnapshot(at, 'manifest') as Ref;
  const manifest = readDiscoveryManifestStructural(store, project, ref).record;
  if (manifest.value.previous !== null || manifest.value.resolutions.length !== 0)
    acceptanceInvalid('previous', 'No condition of this contract is resolved by a later edition: the class of an owner choice is unproven',
      { ref }, 'discovery_condition_class_unproven');
  return readFirstAcceptance(store, project, manifest);
}
/** What an owner choice is proven against: the accepted edition, its saved bundle and the resolutions it carries. */
export interface EditionView { manifest: Revision<DiscoveryManifest>; bundle: Revision<AcceptedFinalBundle>; resolutions: Revision<ConditionResolution>[] }
/** The exact saved records of an edition, read without proving the paid assessment. */
export function readEditionView(store: Store, project: string, ref: Ref): EditionView {
  const manifest = readDiscoveryManifestStructural(store, project, ref).record;
  return { manifest, bundle: exactRecord<AcceptedFinalBundle>(store, manifest.value.bundle, ACCEPTED_FINAL_BUNDLE_KIND, `${ACCEPTED_FINAL_BUNDLE_KIND}:`, 'bundle'),
    resolutions: manifest.value.resolutions.map(item =>
      exactRecord<ConditionResolution>(store, item, CONDITION_RESOLUTION_KIND, `${CONDITION_RESOLUTION_KIND}:`, 'resolution')) };
}
async function readFirstAcceptance(store: Store, project: string, manifest: Revision<DiscoveryManifest>): Promise<AcceptedDiscovery> {
  if (manifest.value.resolutions.length !== 0)
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
  const ids = grounds.bundle.verdict.conditions.map(condition => (condition as { id: string }).id);
  return structuredClone({ verification: 'accepted', manifest, bundle, admission, grounds, resolutions: [],
    conditions: { resolved: [], open: ids } });
}

/* DR7 7b.3 (codex-omg2 №16156 п.1, №16160, №16169): the owner's authorized choice on one owner_choice condition of an
 * accepted conditional bundle. The choice is the owner's separate scoped act on an offered option, saved with its
 * consequences; the acceptance authority, a v6 authority and bypass mode do not stand for it. It fulfils no condition:
 * the old contract carries no proven class of an owner choice (a choice inside the bundle, a boundary, a risk), so an
 * accepting choice is returned with the address of a new D7 and the condition stays open; a declining one is the owner's
 * refusal. No later edition and no successor is written. The address of the one successor of an edition is kept absent
 * in the guarded write of every act, so the act always stands on the latest edition. */
export const CONDITION_CHOICE_ACTION = 'discovery-final-condition-choice' as const;
export const CONDITION_CHOICE_GRANT_CONTRACT = 'owner-session-grant/v7' as const;
export const CONDITION_CHOICE_SESSION_CONTRACT = 'owner-session/v7' as const;
export const CONDITION_CHOICE_GRANT_PREFIX = 'owner-final-condition-grant:';
export const CONDITION_CHOICE_SESSION_PREFIX = 'owner-final-condition-session:';
export const CONDITION_CHOICE_GRANT_LIFETIME_MS = 10 * 60_000;
export const CONDITION_CHOICE_SESSION_LIFETIME_MS = 30 * 60_000;
export const CONDITION_RESOLUTION_KIND = 'discovery-condition-resolution' as const;
export const CONDITION_RESOLUTION_CONTRACT = 'discovery-condition-resolution/v1' as const;
export const MANIFEST_SUCCESSOR_KIND = 'discovery-manifest-successor' as const;

/** One exact owner choice: the project, the exact edition it is made on and its saved bundle, the condition of that
 * bundle, the offered option and the owner's reason. */
export interface ConditionChoiceScope { projectId: string; predecessor: Ref; bundle: Ref; conditionId: string; optionId: string; reason: string }
export interface ConditionChoiceGrant {
  contract: typeof CONDITION_CHOICE_GRANT_CONTRACT; id: string; database: string; action: typeof CONDITION_CHOICE_ACTION;
  method: typeof FINAL_ACCEPTANCE_PAIRING_METHOD; scope: ConditionChoiceScope; issuedAt: number; expiresAt: number; proof: string;
}
export interface ConditionChoiceSession {
  contract: typeof CONDITION_CHOICE_SESSION_CONTRACT; grant: Ref; database: string; action: typeof CONDITION_CHOICE_ACTION;
  method: typeof FINAL_ACCEPTANCE_PAIRING_METHOD; scope: ConditionChoiceScope; session: string; openedAt: number; expiresAt: number;
  state: 'open' | 'closed'; closedAt?: number;
}
export interface ConditionOption { optionId: string; label: string; consequences: string[]; choice: 'accept' | 'decline' }
/** The saved owner choice on one condition of one saved bundle: the offered option verbatim, with its consequences. */
export interface ConditionResolution {
  contract: typeof CONDITION_RESOLUTION_CONTRACT; database: string; projectId: string; predecessor: Ref; bundle: Ref; conditionId: string;
  kind: 'owner_choice'; option: ConditionOption; scope: ConditionChoiceScope; authority: { grant: Ref; session: Ref }; at: number;
}
export function requireConditionChoiceScope(value: unknown): ConditionChoiceScope {
  if (!plain(value) || !exactKeys(value, ['projectId', 'predecessor', 'bundle', 'conditionId', 'optionId', 'reason'])
    || !text(value.projectId) || !exactRef(value.predecessor) || !exactRef(value.bundle) || !text(value.conditionId) || !text(value.optionId)
    || !text(value.reason))
    acceptanceInvalid('scope', 'An owner choice names the project, the exact edition and bundle, the condition, the offered option and a reason only',
      {}, 'discovery_condition_resolution_invalid');
  return { projectId: value.projectId as string, predecessor: exact(value.predecessor as Ref), bundle: exact(value.bundle as Ref),
    conditionId: value.conditionId as string, optionId: value.optionId as string, reason: value.reason as string };
}
const CONDITION_CHOICE_SPEC: OwnerSessionSpec<ConditionChoiceScope> = { label: 'owner choice', action: CONDITION_CHOICE_ACTION,
  grantContract: CONDITION_CHOICE_GRANT_CONTRACT, sessionContract: CONDITION_CHOICE_SESSION_CONTRACT,
  grantPrefix: CONDITION_CHOICE_GRANT_PREFIX, sessionPrefix: CONDITION_CHOICE_SESSION_PREFIX,
  grantLifetime: CONDITION_CHOICE_GRANT_LIFETIME_MS, sessionLifetime: CONDITION_CHOICE_SESSION_LIFETIME_MS, scope: requireConditionChoiceScope };
export const conditionChoiceSessionId = (grant: Ref) => sessionIdOf(CONDITION_CHOICE_SESSION_PREFIX, grant);
export function readConditionChoiceGrant(store: Store, ref: unknown): Revision<ConditionChoiceGrant> {
  return readScopedGrant<ConditionChoiceGrant, ConditionChoiceScope>(store, ref, CONDITION_CHOICE_SPEC);
}
export function readConditionChoiceSession(store: Store, ref: unknown): Revision<ConditionChoiceSession> {
  return readScopedSession<ConditionChoiceSession, ConditionChoiceScope>(store, ref, CONDITION_CHOICE_SPEC);
}
/** One owner act per condition of one saved bundle, and the one successor address of an edition. */
export const conditionResolutionId = (projectId: string, bundle: Ref, conditionId: string) =>
  `${CONDITION_RESOLUTION_KIND}:${projectId}:${hashJson({ bundle: exact(bundle), conditionId } as never)}`;
export const manifestSuccessorId = (predecessor: Ref) => `${MANIFEST_SUCCESSOR_KIND}:${hashJson(exact(predecessor) as never)}`;

/** The saved owner choice on one condition at its canonical address, with the edition it names, before it is proven;
 * null when there is none. */
export function readSavedResolution(store: Store, id: string): { row: Revision<ConditionResolution>; predecessor: Ref } | null {
  if (!store.get(id, 1)) return null;
  const row = soleRecord<ConditionResolution>(store, id, CONDITION_RESOLUTION_KIND, 'resolution');
  const value = row.value as unknown as Record<string, unknown>;
  if (!exactRef(value.predecessor)) acceptanceInvalid('resolution', 'A saved owner choice names its exact predecessor edition', { id });
  return { row, predecessor: exact(value.predecessor as Ref) };
}
/** The owner_choice condition of the accepted bundle and its offered option; an evidence condition is not an owner choice. */
export function offeredConditionOption(accepted: EditionView, conditionId: string, optionId: string):
  { condition: Record<string, unknown>; option: ConditionOption } {
  const conditions = (accepted.bundle.value as { bundle?: { verdict?: { conditions?: unknown } } }).bundle?.verdict?.conditions;
  if (!Array.isArray(conditions)) acceptanceInvalid('bundle', 'The saved bundle keeps its verdict conditions', {}, 'discovery_condition_resolution_invalid');
  const condition = (conditions as unknown[]).find(item => plain(item) && item.id === conditionId) as Record<string, unknown> | undefined;
  if (!condition) acceptanceInvalid('conditionId', 'The condition is not one of this accepted bundle', {}, 'discovery_condition_resolution_invalid');
  if (condition!.kind === 'evidence')
    acceptanceInvalid('conditionId', 'An evidence condition is fulfilled by proven material, never by an owner choice', {}, 'discovery_condition_evidence_unproven');
  if (condition!.kind !== 'owner_choice' || !Array.isArray(condition!.options))
    acceptanceInvalid('conditionId', 'Only an offered owner condition is resolved by the owner', {}, 'discovery_condition_resolution_invalid');
  const option = (condition!.options as unknown[]).find(item => plain(item) && item.optionId === optionId);
  if (!option) acceptanceInvalid('optionId', 'The owner chooses one option the condition offers', {}, 'discovery_condition_resolution_invalid');
  return { condition: condition!, option: structuredClone(option) as ConditionOption };
}
/** The one write of an owner act: the saved choice at its canonical address. */
export function conditionResolutionWrites(project: string, accepted: AcceptedDiscovery, resolution: ConditionResolution): Write[] {
  return [{ id: conditionResolutionId(project, accepted.manifest.value.bundle, resolution.conditionId), kind: CONDITION_RESOLUTION_KIND,
    expected: 0, value: resolution }];
}
/** The saved owner act, proved from its own grounds over the edition it was made on: this bundle, an offered option, the exact scope and the exact open session and grant inside their windows. */
export function proveConditionResolution(store: Store, project: string, ref: unknown, predecessor: EditionView): Revision<ConditionResolution> {
  const row = exactRecord<ConditionResolution>(store, ref, CONDITION_RESOLUTION_KIND, `${CONDITION_RESOLUTION_KIND}:`, 'resolution');
  const value = row.value as unknown as Record<string, unknown>, at = reference(row);
  if (row.revision !== 1 || !exactKeys(value, ['contract', 'database', 'projectId', 'predecessor', 'bundle', 'conditionId', 'kind', 'option', 'scope',
    'authority', 'at']) || value.contract !== CONDITION_RESOLUTION_CONTRACT || value.database !== store.databaseId || value.projectId !== project
    || value.kind !== 'owner_choice' || !exactRef(value.predecessor) || !same(value.predecessor, reference(predecessor.manifest))
    || !exactRef(value.bundle) || !same(value.bundle, predecessor.manifest.value.bundle) || !text(value.conditionId)
    || row.id !== conditionResolutionId(project, value.bundle, value.conditionId) || !Number.isSafeInteger(value.at))
    acceptanceInvalid('resolution', 'An owner choice keeps its complete v1 provenance on this exact bundle', { ref: at });
  const scope = requireConditionChoiceScope(value.scope);
  if (scope.projectId !== project || !same(scope.predecessor, value.predecessor) || !same(scope.bundle, value.bundle)
    || scope.conditionId !== value.conditionId)
    acceptanceInvalid('scope', 'The owner choice was made on its exact predecessor edition, bundle and condition', { ref: at });
  if (predecessor.resolutions.some(item => item.value.conditionId === scope.conditionId))
    acceptanceInvalid('resolution', 'A condition is resolved once', { ref: at });
  const offered = offeredConditionOption(predecessor, scope.conditionId, scope.optionId);
  if (!same(value.option, offered.option))
    acceptanceInvalid('option', 'The saved option is the offered one verbatim, with its consequences', { ref: at });
  requireActSession(store, value.authority, scope, value.at as number, CONDITION_CHOICE_SPEC, at);
  return row;
}

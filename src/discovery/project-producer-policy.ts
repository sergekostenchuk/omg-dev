import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, TransactionGuard } from '../storage/store.js';
import type { ProducerPolicy } from './requirements.js';

export const PRODUCER_POLICY_DOOR = 'owner-producer-policy';
export const producerPolicyId = (project: string) => `project-producer-policy:${project}`;
export interface ProducerPolicyScope { project: string; discovery: 6 | 7; previous: Ref | null }
export interface ProducerPolicyGrant {
  contract: 'producer-policy-grant/v1'; database: string; project: Ref; scope: ProducerPolicyScope;
  secretHash: string; issuedAt: number; expiresAt: number;
}
export interface ProducerPolicySession {
  contract: 'producer-policy-session/v1'; database: string; grant: Ref; scope: ProducerPolicyScope;
  openedAt: number; expiresAt: number; revokedAt: number | null;
}
export interface ProjectProducerPolicy {
  contract: 'project-producer-policy/v1'; database: string; project: string; discovery: 6 | 7;
  previous: Ref | null; session: Ref; at: number;
}
export const policySame = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const policyExactRef = (v: unknown): v is Ref => object(v) && isRef(v)
  && Object.keys(v).sort().join(',') === 'hash,id,revision';
export function policyRequire(value: unknown, message: string): asserts value {
  if (!value) throw new EngineError('producer_policy_invalid', message, { door: PRODUCER_POLICY_DOOR });
}
export function producerPolicyScope(input: unknown): ProducerPolicyScope {
  let v: unknown;
  try { v = JSON.parse(canonical(input)); }
  catch { throw new EngineError('producer_policy_invalid', 'Expected one JSON producer policy', { door: PRODUCER_POLICY_DOOR }); }
  policyRequire(object(v) && Object.keys(v).sort().join(',') === 'discovery,previous,project'
    && typeof v.project === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v.project)
    && (v.discovery === 6 || v.discovery === 7) && (v.previous === null || policyExactRef(v.previous)),
  'The owner policy names project, discovery:6|7 and exact previous or null');
  return v as unknown as ProducerPolicyScope;
}
export function policyRecord<T>(store: Store, at: Ref, kind: string): Revision<T> {
  policyRequire(policyExactRef(at), 'Expected an exact policy ground');
  const row = store.get<T>(at.id, at.revision);
  policyRequire(row?.kind === kind && policySame(reference(row), at) && hashJson(row.value) === row.hash,
    'A producer policy ground is absent, foreign or changed');
  return row;
}
export function proveProducerPolicySession(store: Store, at: Ref, scope: ProducerPolicyScope): Revision<ProducerPolicySession> {
  const row = policyRecord<ProducerPolicySession>(store, at, 'owner-session'), s = row.value;
  policyRequire(object(s) && Object.keys(s).sort().join(',') === 'contract,database,expiresAt,grant,openedAt,revokedAt,scope'
    && s.contract === 'producer-policy-session/v1' && s.database === store.databaseId && s.revokedAt === null
    && policySame(producerPolicyScope(s.scope), scope) && policyExactRef(s.grant)
    && row.id === `producer-policy-session:${hashJson(s.grant)}` && row.revision === 1
    && Number.isSafeInteger(s.openedAt) && Number.isSafeInteger(s.expiresAt) && s.expiresAt > s.openedAt,
  'The saved owner session does not authorize this exact producer policy');
  const grant = policyRecord<ProducerPolicyGrant>(store, s.grant, 'owner-session-grant'), g = grant.value;
  policyRequire(object(g) && Object.keys(g).sort().join(',') === 'contract,database,expiresAt,issuedAt,project,scope,secretHash'
    && g.contract === 'producer-policy-grant/v1' && g.database === s.database && grant.revision === 1
    && grant.id === `producer-policy-grant:${hashJson(g)}` && policyExactRef(g.project)
    && policySame(producerPolicyScope(g.scope), scope) && /^[a-f0-9]{64}$/.test(g.secretHash)
    && Number.isSafeInteger(g.issuedAt) && Number.isSafeInteger(g.expiresAt)
    && g.issuedAt <= s.openedAt && s.openedAt < g.expiresAt,
  'The policy session lost its project-bound owner grant');
  const project = policyRecord<{id: string}>(store, g.project, 'project');
  policyRequire(project.id === `project:${scope.project}` && project.value?.id === scope.project,
    'The owner grant belongs to another project');
  return row;
}
export function readProjectProducerPolicy(store: Store, project: string, at?: Ref): Revision<ProjectProducerPolicy> | null {
  const row = at ? policyRecord<ProjectProducerPolicy>(store, at, 'project-producer-policy')
    : store.get<ProjectProducerPolicy>(producerPolicyId(project));
  if (!row) return null;
  const v = row.value;
  policyRequire(row.kind === 'project-producer-policy' && row.id === producerPolicyId(project)
    && object(v) && Object.keys(v).sort().join(',') === 'at,contract,database,discovery,previous,project,session'
    && v.contract === 'project-producer-policy/v1' && v.database === store.databaseId && v.project === project
    && (v.discovery === 6 || v.discovery === 7) && row.hash === hashJson(v) && policyExactRef(v.session)
    && Number.isSafeInteger(v.at) && v.at > 0
    && (row.revision === 1 ? v.previous === null : policyExactRef(v.previous)
      && v.previous.id === row.id && v.previous.revision === row.revision - 1),
  'The project producer policy is malformed or lost its owner provenance');
  const scope = producerPolicyScope({ project, discovery: v.discovery, previous: v.previous });
  const session = proveProducerPolicySession(store, v.session, scope);
  policyRequire(session.value.openedAt <= v.at && v.at < session.value.expiresAt,
    'The policy was not written during its scoped owner session');
  if (v.previous) {
    const prior = readProjectProducerPolicy(store, project, v.previous);
    policyRequire(prior && prior.value.at <= v.at, 'The policy chain lost its exact preceding decision');
  }
  return structuredClone(row);
}
export function projectProducerSelection(store: Store, project: string, fallback?: ProducerPolicy): {
  policy: ProducerPolicy | undefined; record: Revision<ProjectProducerPolicy> | null; guards: TransactionGuard[];
} {
  const record = readProjectProducerPolicy(store, project);
  return { record, policy: record ? Object.freeze({ ...fallback, discovery: record.value.discovery }) : fallback,
    guards: [record ? reference(record) : { id: producerPolicyId(project), absent: true }] };
}

type Selection = ReturnType<typeof projectProducerSelection>;
const operationPolicy = new AsyncLocalStorage<{database: string; project: string; record: Ref}>();
/** One operation pins its proven opt-in. Paid restoration never enters this scope. */
export function withProjectProducerSelection<T>(store: Store, project: string, selected: Selection | null, work: () => T): T {
  return selected?.record ? operationPolicy.run({database: store.databaseId, project,
    record: reference(selected.record)}, work) : work();
}
/** Only new v7 claims carry this optional ground; legacy calls retain their original contract. */
export function producerDispatchPolicy(store: Store, project: string, draftId: string): Ref | null {
  const draft = store.get<{stage: string; contractVersion?: number; projectId: string}>(draftId);
  if (draft?.kind !== 'discovery-draft' || draft.value.stage !== 'discovery' || draft.value.contractVersion !== 7) return null;
  policyRequire(draft.value.projectId === project, 'The dispatch draft belongs to another project');
  const scope = operationPolicy.getStore();
  const pinned = scope?.database === store.databaseId && scope.project === project ? scope.record : undefined;
  const record = readProjectProducerPolicy(store, project);
  if (!record && !pinned) return null; // Existing trusted code opt-ins remain compatible.
  if (!(record?.value.discovery === 7 && (!pinned || policySame(reference(record), pinned))))
    throw new EngineError('producer_policy_changed', 'The owner producer policy no longer permits this new Discovery dispatch',
      {door: PRODUCER_POLICY_DOOR, project});
  return reference(record);
}
export function producerDispatchGuards(store: Store, project: string, permission: unknown): TransactionGuard[] {
  if (permission === undefined || permission === null) return [];
  policyRequire(policyExactRef(permission), 'The new claim lost its exact producer-policy permission');
  const permitted = readProjectProducerPolicy(store, project, permission);
  const current = store.get(producerPolicyId(project));
  if (!(permitted?.value.discovery === 7 && current && policySame(reference(current), permission)))
    throw new EngineError('producer_policy_changed', 'The owner producer policy changed before this new dispatch', {door: PRODUCER_POLICY_DOOR, project});
  return [permission];
}

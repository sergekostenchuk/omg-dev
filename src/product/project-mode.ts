import { hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { isRef, reference, type Ref } from "../pipeline/contracts.js";
import { uniqueTransactionGuards } from "../runtime/environment.js";
import { Store, type Revision } from "../storage/store.js";
import {
  ProjectModeAuthority, requireProjectModeAuthority,
  readProjectModeSession, readProjectModeSessionGrant, PROJECT_MODE_ACTION,
  type ProjectMode, type ProjectModeScope,
} from "./owner-authority.js";

/**
 * DR1a: the owner project-mode decision — a persisted project-mode/v1 record at project-mode:<project>, written only
 * through the separate project-mode authority branch (owner-session-grant/v3 + owner-session/v3). Neither the general
 * owner-result session nor the Discovery choice session can stand for it. The record carries its own provenance: the
 * database and project binding, the exact scope the minted authority covered (project, mode, exact previous or null),
 * the exact session Ref that authorized it, and the previous decision Ref it builds on. The reader re-proves the whole
 * chain from saved records — a missing record is project_mode_unset, never a default; a malformed record is a separate
 * project_mode_invalid refusal. Historical decisions stay readable after session expiry and process restart.
 */
export const PROJECT_MODE_RECORD_CONTRACT = 'project-mode/v1';
export const PROJECT_MODE_RECORD_KIND = 'project-mode';
export const PROJECT_MODE_DOOR = 'owner-project-mode';
export const projectModeId = (project: string) => `project-mode:${project}`;

export interface ProjectModeRecord {
  contract: typeof PROJECT_MODE_RECORD_CONTRACT; database: string; project: string; mode: ProjectMode;
  authority: { session: Ref; scope: ProjectModeScope };
  previous: Ref | null; at: number;
}
export interface ProjectModeRequest { project: string; mode: ProjectMode; previous: Ref | null }
export interface ProjectModeOutcome { record: Revision<ProjectModeRecord>; repeated: boolean }
export interface ProjectModeStatus { record: Revision<ProjectModeRecord>; mode: ProjectMode; ref: Ref }

const shape = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const same = (left: unknown, right: unknown) => hashJson(left) === hashJson(right);

function authorityFailure(result: ReturnType<typeof requireProjectModeAuthority>): never {
  if (result.ok) throw new EngineError('owner_authority_internal', 'Authority refusal unexpectedly delivered a value');
  throw new EngineError(result.refusal.code, result.refusal.message, { ...result.refusal.at, door: PROJECT_MODE_DOOR });
}

export function requireProjectModeRequest(request: unknown): ProjectModeRequest {
  if (!shape(request) || Object.keys(request).some(key => !['project', 'mode', 'previous'].includes(key)))
    throw new EngineError('project_mode_invalid',
      'A project-mode request names project, mode and the exact previous record or null only',
      { door: PROJECT_MODE_DOOR });
  if (!isText(request.project) || (request.mode !== 'questions' && request.mode !== 'bypass')
    || (request.previous !== null && !isRef(request.previous)))
    throw new EngineError('project_mode_invalid',
      'A project-mode scope is a project, the mode questions|bypass and the exact previous record or null',
      { project: isText(request.project) ? request.project : 'project-mode', door: PROJECT_MODE_DOOR });
  const previous = request.previous as Ref | null;
  return { project: request.project, mode: request.mode,
    previous: previous === null ? null : { id: previous.id, revision: previous.revision, hash: previous.hash } };
}

/** Trusted CLI preflight: prove the addressed grounds before minting the one-use scoped invitation. */
export function validateProjectModeRequest(store: Store, request: unknown): ProjectModeRequest {
  requireCondition(store instanceof Store, 'project_mode_invalid', 'A project-mode decision needs a Store');
  const scope = requireProjectModeRequest(request);
  if (!store.get(`project:${scope.project}`))
    throw new EngineError('owner_project_missing', 'A project-mode decision addresses an existing project only',
      { project: scope.project, door: PROJECT_MODE_DOOR });
  const previous = scope.previous === null ? null : store.get(scope.previous.id, scope.previous.revision);
  if (scope.previous !== null && (!previous || previous.hash !== scope.previous.hash))
    throw new EngineError('project_mode_stale', 'The named previous mode record is not stored',
      { project: scope.project, previous: scope.previous, door: PROJECT_MODE_DOOR });
  return scope;
}

/**
 * Re-derive a stored project-mode decision from its own saved grounds: shape, binding, the exact v3 session and grant
 * that authorized it, the scope they covered, and the previous-decision chain. Session expiry does not matter here —
 * the exact session revision persists — so a historical record proves itself after logout and restart alike.
 */
function proveProjectModeRecord(store: Store, project: string, record: Revision<ProjectModeRecord>):
  Revision<ProjectModeRecord> {
  const value = record.value;
  const invalid = (field: string, message: string): never => {
    throw new EngineError('project_mode_invalid', message,
      { project, record: reference(record), field, door: PROJECT_MODE_DOOR });
  };
  if (record.kind !== PROJECT_MODE_RECORD_KIND || record.id !== projectModeId(project)
    || !shape(value) || value.contract !== PROJECT_MODE_RECORD_CONTRACT
    || value.database !== store.databaseId || value.project !== project
    || (value.mode !== 'questions' && value.mode !== 'bypass')
    || !shape(value.authority) || !isRef(value.authority.session) || !shape(value.authority.scope)
    || !same(value.authority.scope, { project: value.project, mode: value.mode, previous: value.previous })
    || (record.revision === 1
      ? value.previous !== null
      : !(isRef(value.previous) && value.previous.id === record.id && value.previous.revision === record.revision - 1))
    || !Number.isSafeInteger(value.at) || value.at <= 0
    || Object.keys(value).some(key => !['contract', 'database', 'project', 'mode', 'authority', 'previous', 'at'].includes(key))
    || Object.keys(value.authority).some(key => !['session', 'scope'].includes(key))
    || Object.keys(value.authority.scope).some(key => !['project', 'mode', 'previous'].includes(key)))
    return invalid('contract', 'A project-mode record keeps its complete v1 provenance');
  const session = readProjectModeSession(store, value.authority.session);
  // The referenced revision is the exact open one the writer pinned — never a moved head; every relation is
  // checked against the saved times of the chain, so a lawful decision stays readable after expiry and restart
  // while a decision made by a closed, expired or foreign session does not prove itself.
  if (!session.ok || session.value.value.state !== 'open'
    || session.value.value.database !== store.databaseId
    || !same(session.value.value.scope, value.authority.scope)
    || session.value.value.openedAt > value.at || value.at >= session.value.value.expiresAt)
    return invalid('session', 'The mode decision was authorized by its exact saved open project-mode session');
  const grant = readProjectModeSessionGrant(store, session.value.value.grant);
  if (!grant.ok || grant.value.value.database !== store.databaseId
    || !same(grant.value.value.scope, session.value.value.scope)
    || grant.value.value.issuedAt > session.value.value.openedAt
    || session.value.value.openedAt >= grant.value.value.expiresAt)
    return invalid('grant', 'The mode session descends from its exact saved project-mode grant');
  if (value.previous !== null) {
    const prior = store.get<ProjectModeRecord>(value.previous.id, value.previous.revision);
    if (!prior || prior.hash !== value.previous.hash)
      return invalid('previous', 'The previous mode decision is not the stored record it names');
    if (proveProjectModeRecord(store, project, prior).value.at > value.at)
      return invalid('previous', 'The previous mode decision is saved later than this record');
  }
  return record;
}

/** The trusted reader: the current head by default, or the exact saved Ref it is given. Never a default. */
export function readProjectMode(store: Store, project: string, record?: Ref): ProjectModeStatus {
  requireCondition(store instanceof Store, 'project_mode_invalid', 'The project-mode reader needs a Store');
  requireCondition(isText(project), 'project_mode_invalid', 'The project-mode reader needs a project');
  const found = record === undefined
    ? store.get<ProjectModeRecord>(projectModeId(project))
    : store.get<ProjectModeRecord>(record.id, record.revision);
  if (!found || (record !== undefined && (found.id !== record.id || found.hash !== record.hash))) {
    if (record === undefined)
      throw new EngineError('project_mode_unset', 'No project mode is recorded for this project',
        { project, door: PROJECT_MODE_DOOR });
    throw new EngineError('project_mode_invalid', 'The named project-mode record is not stored as referenced',
      { project, record, door: PROJECT_MODE_DOOR });
  }
  const proved = proveProjectModeRecord(store, project, found);
  return { record: proved, mode: proved.value.mode, ref: reference(proved) };
}

/** The single protected producer. Only a minted project-mode authority bound to this exact scope may write. */
export function setProjectMode(store: Store, request: unknown, authority: unknown): ProjectModeOutcome {
  if (!(authority instanceof ProjectModeAuthority)) {
    const refused = requireProjectModeAuthority(authority, { store, action: PROJECT_MODE_ACTION,
      scope: { project: '', mode: 'questions', previous: null } });
    return authorityFailure(refused);
  }
  const scope = requireProjectModeRequest(request);
  const admitted = requireProjectModeAuthority(authority, { store, action: PROJECT_MODE_ACTION, scope });
  if (!admitted.ok) return authorityFailure(admitted);
  const project = store.get(`project:${scope.project}`);
  if (!project)
    throw new EngineError('owner_project_missing', 'A project-mode decision addresses an existing project only',
      { project: scope.project, door: PROJECT_MODE_DOOR });
  const id = projectModeId(scope.project);
  const head = store.get<ProjectModeRecord>(id);
  if (head) {
    proveProjectModeRecord(store, scope.project, head);
    if (same(head.value.authority.scope, scope)) return { record: head, repeated: true };
  }
  if (head ? scope.previous === null || !same(reference(head), scope.previous) : scope.previous !== null)
    throw new EngineError('project_mode_stale', 'The mode head moved since this decision was scoped',
      { project: scope.project, expected: scope.previous, actual: head ? reference(head) : null,
        door: PROJECT_MODE_DOOR });
  // The second exercise closes the check-to-write window; the pinned session revision is a transaction guard, so a
  // revocation racing the commit is refused by the store itself. The record's `at` is the exact instant the
  // authority proved the session live — one checked moment, not a second unsampled clock read.
  const applied = requireProjectModeAuthority(authority, { store, action: PROJECT_MODE_ACTION, scope });
  if (!applied.ok) return authorityFailure(applied);
  // A decision may never be older than the head it follows — a clock that stepped back would otherwise persist a
  // record its own reader refuses, so the checked moment is compared to the saved head before any write.
  if (head && head.value.at > applied.value.at)
    throw new EngineError('project_mode_stale', 'The mode decision is not younger than the recorded head',
      { project: scope.project, expected: head.value.at, actual: applied.value.at, door: PROJECT_MODE_DOOR });
  const value: ProjectModeRecord = { contract: PROJECT_MODE_RECORD_CONTRACT, database: store.databaseId,
    project: scope.project, mode: scope.mode,
    authority: { session: applied.value.session,
      scope: { project: scope.project, mode: scope.mode, previous: scope.previous } },
    previous: head ? reference(head) : null, at: applied.value.at };
  try {
    const written = store.writeMany<ProjectModeRecord>([
      { id, kind: PROJECT_MODE_RECORD_KIND, expected: head ? head.revision : 0, value }],
      uniqueTransactionGuards([reference(project),
        head ? reference(head) : { id, absent: true }, applied.value.session]));
    return { record: written[0]!, repeated: false };
  } catch (error) {
    if (error instanceof EngineError && ['revision_conflict', 'input_stale'].includes(error.code)) {
      const latest = store.get<ProjectModeRecord>(id);
      if (latest) {
        const recoveredAdmission = requireProjectModeAuthority(authority,
          { store, action: PROJECT_MODE_ACTION, scope });
        if (!recoveredAdmission.ok) return authorityFailure(recoveredAdmission);
        proveProjectModeRecord(store, scope.project, latest);
        if (same(latest.value.authority.scope, scope)) return { record: latest, repeated: true };
        throw new EngineError('project_mode_stale', 'A competing mode switch reached the store first',
          { project: scope.project, expected: scope.previous, actual: reference(latest), door: PROJECT_MODE_DOOR });
      }
    }
    throw error;
  }
}

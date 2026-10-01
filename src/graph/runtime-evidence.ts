import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { canonical, hashJson } from '../canonical.js';
import { EngineError } from '../errors.js';
import { Evidence, type Source, type Observation } from '../evidence/evidence.js';
import type { FieldSpec } from '../discovery/discovery.js';
import type { TechnicalReport } from './research-contracts.js';
import type { Store, Revision, TransactionGuard } from '../storage/store.js';
import { reference, isRef, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import type { ResearchScope } from './research-scope.js';
import { obligationAssignment, type ObligationAssignment, type RuntimeCheck } from './obligation-policy.js';
import { runtimeContext, runtimeCode, runtimeExecutableIdentity, runtimeSubjectPath, omRuntimeAssignment,
  declaredCheckSources } from '../runtime/runtime-observation.js';
import { runtimeSource, type RuntimeObservation } from '../runtime/runtime-observation-model.js';
import { uniqueTransactionGuards } from '../runtime/environment.js';
import { readOmObligationLedger } from './om-obligation-readers.js';
import { historicalObservation } from '../discovery/response-recovery.js';

export interface RuntimeEvidence {
  obligation: string; document: string; observation: Ref; source: Ref; authorization: Ref; code: Ref[];
}

type RuntimeMaterials = { proofs: RuntimeEvidence[]; supporting: Observation[]; guards: Ref[]; admissionGuards: TransactionGuard[] };
type SubjectSupport = { record: Revision<RuntimeObservation>; code: Observation[]; full: Observation; guards: Ref[] };
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

function exact<T>(store: Store, ref: Ref, kind: string): Revision<T> | null {
  const saved = isRef(ref) ? store.get<T>(ref.id, ref.revision) : null;
  return saved?.kind === kind && same(reference(saved), ref) && hashJson(saved.value) === ref.hash ? saved : null;
}

function inside(root: string, path: string): boolean {
  if (!isAbsolute(root) || normalize(root) !== root || !isAbsolute(path) || normalize(path) !== path) return false;
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** The declared subject list — count, order and requested/kind — shared by
 * current admission and historical proof. Today's resolved paths and
 * executable identities remain current-admission checks only (R6/№1318-5). */
function declaredRuntimeSubjects(check: RuntimeCheck, subjects: RuntimeObservation['subjects']): boolean {
  const expected = [...check.subjects.map(requested => ({ requested, kind: 'file' })),
    ...check.executables.map(requested => ({ requested, kind: 'executable' }))];
  return Array.isArray(subjects) && subjects.length === expected.length
    && subjects.every((subject, index) => subject && typeof subject === 'object'
      && subject.requested === expected[index]!.requested && subject.kind === expected[index]!.kind);
}

/** The admission basis of one runtime observation — exactly the fields the
 * live collector compares against current state: the runtime binding, the
 * executable path/stat identity, and each declared subject's resolved path
 * and stat identity. All of it is persisted in the observation record, so a
 * historical replay re-derives a candidate's basis from saved material alone
 * (№1971-4, №2000-5). Record revisions (context/scope/environment refs) and
 * the outcome fields are deliberately outside: they are not compared against
 * live state, and a moved revision with unchanged content is lawful. */
export type RuntimeAdmissionBasis = {
  binding: RuntimeObservation['runtimeBinding'];
  executable: { path: string; identity: RuntimeObservation['executable']['identity'] };
  subjects: { requested: string; kind: 'file' | 'executable'; path: string;
    identity: RuntimeObservation['executable']['identity'] }[];
};
function runtimeAdmissionBasis(value: RuntimeObservation): RuntimeAdmissionBasis {
  return {
    binding: value.runtimeBinding,
    executable: { path: value.executable.path, identity: value.executable.identity },
    subjects: value.subjects.map(({ requested, kind, path, identity }) => ({ requested, kind, path, identity })),
  };
}

/** D8.4d (№2141): the admission material of one assessment — what the live
 * collector compared every runtime candidate against, and every candidate it
 * considered, with the outcome and the components of the mismatch. It is
 * saved beside the runtime result in M and is the only basis from which the
 * historical replay derives the selected AND the excluded candidates. The
 * runtime result DTO itself stays exactly the D8.4c form. */
export const RUNTIME_ADMISSION = 'runtime-admission/v1' as const;
/** The live admission of one declared check at the moment of assessment: the
 * basis every candidate of that check was compared with, or the typed reason
 * no basis could be resolved (then no candidate is admitted). */
export interface RuntimeAdmissionReference { check: RuntimeCheck; basis: RuntimeAdmissionBasis | null; unresolved: string | null }
/** One considered candidate: a cited Source with runtime-observation provenance
 * of this project. `basis` is the candidate's own (from its exact record) and
 * re-derives; `mismatch` names what excluded it — basis components and
 * `projection:<reason>` re-derive from exact records, `head:<id>:<revision>` re-derives
 * as the existence of that superseding revision, `current:<code>` is the
 * recorded fact of today's-filesystem admission (R6: a current-only check),
 * proved at the first write of M by the full live derivation. */
export interface RuntimeAdmissionCandidate {
  obligation: string; document: string; citation: number; observation: Ref; source: Ref;
  basis: RuntimeAdmissionBasis; admitted: boolean; mismatch: string[];
}
export interface RuntimeAdmission { contract: typeof RUNTIME_ADMISSION; references: RuntimeAdmissionReference[]; candidates: RuntimeAdmissionCandidate[] }
export const emptyRuntimeAdmission = (): RuntimeAdmission => ({ contract: RUNTIME_ADMISSION, references: [], candidates: [] });
type SelectionMode = { kind: 'current' } | { kind: 'historical'; admission: RuntimeAdmission };
export interface RuntimeSelection { runtime: RuntimeMaterials; admission: RuntimeAdmission }

/** The three outcomes of projecting one cited Source as runtime support of a declared check (№2173):
 *  - `support`  — the exact observation, its Source, declaration, environment and check code all read and agree;
 *  - `excluded` — a subject-matter reason not to count it (another check or declaration, a failed observation, a Source
 *                 that is no runtime observation at all): lawful, re-derivable from the same exact records;
 *  - `lost`     — a MANDATORY exact basis is unavailable or damaged (the observation record, its authorization, its
 *                 environment, the declared check code, the OM ledger/producer, the citation bytes): never an exclusion —
 *                 the caller refuses with the exact Ref and the original reason. */
export type RuntimeProjection =
  | { kind: 'support'; support: SubjectSupport }
  | { kind: 'excluded'; reason: string; record: Revision<RuntimeObservation> | null }
  | { kind: 'lost'; reason: string; ref: Ref; message: string };
const lostBasis = (reason: string, ref: Ref, message: string): RuntimeProjection => ({ kind: 'lost', reason, ref, message });
const excludedBy = (reason: string, record: Revision<RuntimeObservation> | null = null): RuntimeProjection => ({ kind: 'excluded', reason, record });

/** Pure subject-matter projection of exact observation, generated Source,
 * saved declaration and check code, telling support, lawful exclusion and a
 * lost mandatory basis apart. Nothing is read at a head. */
export function projectRuntimeCandidate(store: Store, project: string, assignment: ObligationAssignment, sourceRef: Ref): RuntimeProjection {
  if (!assignment?.runtimeCheck) return excludedBy('not-a-runtime-obligation');
  const source = exact<Source>(store, sourceRef, 'source');
  if (!source) return lostBasis('source-missing', sourceRef, 'The cited Source is not readable at its exact reference');
  const ref = source.value.provenance?.record;
  if (source.value.projectId !== project || source.value.provenance?.kind !== 'runtime-observation' || !isRef(ref))
    return excludedBy('not-a-runtime-observation');
  const record = exact<RuntimeObservation>(store, ref, 'runtime-observation');
  if (!record) return lostBasis('observation-missing', ref, 'The runtime observation named by the cited Source is not readable at its exact reference');
  const value = record.value;
  try {
    if (value.version !== 1 || value.projectId !== project || typeof value.key !== 'string' || !value.key
      || record.id !== `runtime-observation:${hashJson([project, value.key])}`
      || !isRef(value.scope) || !isRef(value.environment) || !Array.isArray(value.context) || !value.context.every(isRef))
      return lostBasis('observation-damaged', ref, 'The runtime observation record is malformed');
    // A Source the intact observation does not generate (altered data, a copy, a later rewritten revision) is not this
    // observation's output at all: a subject-matter rejection of the citation, never a lost basis of the observation.
    if (!same(runtimeSource(record), { id: source.id, value: source.value })) return excludedBy('source-not-generated-by-observation');
    if (value.status !== 'observed' || value.result?.signal !== null || !Number.isInteger(value.result?.exitCode))
      return excludedBy('observation-not-observed', record);
    if (!same(value.check, assignment.runtimeCheck)) return excludedBy('another-check', record);
    if ('scope' in assignment && isRef(assignment.scope) && assignment.scope.id.startsWith('om-obligations:')
      && !same(assignment.scope, value.scope)) return excludedBy('another-declaration-scope', record);
    let declarationGuards: Ref[] = [];
    if (value.scope.id.startsWith('om-obligations:')) {
      let declared: ReturnType<typeof omRuntimeAssignment>;
      try { declared = omRuntimeAssignment(store, project, value.scope, value.requestedFor, false); }
      catch (error) { return lostBasis('declaration-unreadable', value.scope, error instanceof EngineError ? error.code : String(error)); }
      if (!same(declared.assignment, assignment)) return excludedBy('declaration-differs', record);
      const ledger = readOmObligationLedger(store, { project, ledger: value.scope });
      if (!ledger.ok) return lostBasis('ledger-unreadable', value.scope, ledger.refusal.code);
      declarationGuards = [reference(ledger.value.producer), reference(ledger.value.record)];
    } else {
      const authorization = exact<ResearchScope>(store, value.scope, 'research-scope');
      if (!authorization || authorization.value.projectId !== project)
        return lostBasis('authorization-missing', value.scope, 'The research scope that authorized the observation is not readable at its exact reference');
      let declared: ObligationAssignment | null;
      try { declared = obligationAssignment(authorization.value, value.requestedFor); }
      catch (error) { return lostBasis('declaration-unreadable', value.scope, error instanceof EngineError ? error.code : String(error)); }
      if (!declared) return lostBasis('declaration-missing', value.scope, 'The research scope does not declare the obligation the observation was requested for');
      const { scope: _scope, wake: _wake, ...bare } = assignment as ObligationAssignment & { scope?: Ref; wake?: unknown };
      if (!same(declared, bare)) return excludedBy('declaration-differs', record);
    }
    const environment = exact(store, value.environment, 'environment');
    if (!environment) return lostBasis('environment-missing', value.environment, 'The environment the observation ran under is not readable at its exact reference');
    if (!isRef(value.check.script) || !Array.isArray(value.check.dependencies) || !value.check.dependencies.every(isRef))
      return lostBasis('check-code-undeclared', ref, 'The observed check declares no exact code sources');
    for (const codeRef of uniqueRefs([value.check.script, ...value.check.dependencies]))
      if (!exact<Source>(store, codeRef, 'source')) return lostBasis('check-code-missing', codeRef, 'A declared check code Source is not readable at its exact reference');
    const sources = declaredCheckSources(project, value.check, value.codeRoot, codeRef => exact<Source>(store, codeRef, 'source'), inside);
    if (!sources) return lostBasis('check-code-invalid', value.check.script, 'The declared check code Sources are not the versioned project code of the observation');
    const code = sources.map(item => historicalObservation(store, project,
      { source: reference(item), selector: { kind: 'text-range', start: 0, end: item.value.content.length } }));
    const requiredContext = uniqueRefs([value.environment, ...declarationGuards, ...code.map(item => item.source)]);
    if (requiredContext.some(item => !value.context.some(saved => same(saved, item))))
      return lostBasis('context-incomplete', ref, 'The observation does not record its mandatory environment, declaration and code context');
    const full = historicalObservation(store, project, { source: sourceRef, selector: { kind: 'json-pointer', pointer: '' } });
    return { kind: 'support', support: { record, code, full,
      guards: uniqueRefs([reference(record), sourceRef, ...declarationGuards, ...code.map(item => item.source)]) } };
  } catch (error) {
    return lostBasis('observation-unreadable', ref, error instanceof EngineError ? `${error.code}: ${error.message}` : String(error));
  }
}
/** The support-or-nothing view of the projection for the current admission of other consumers. */
export function projectRuntimeSupportAt(store: Store, project: string, assignment: ObligationAssignment, sourceRef: Ref): SubjectSupport | null {
  const projection = projectRuntimeCandidate(store, project, assignment, sourceRef);
  return projection.kind === 'support' ? projection.support : null;
}

export function runtimeSupport(store:Store,project:string,assignment:ObligationAssignment,sourceRef:Ref){
  if(!assignment.runtimeCheck)return null;
  try{
    const current=runtimeContext(store,project);
    const projected=projectRuntimeSupportAt(store,project,assignment,sourceRef);
    if(!projected)return null;
    const source=store.get<Source>(sourceRef.id),record=store.get<RuntimeObservation>(projected.record.id);
    if(!source||!record||!same(reference(source),sourceRef)||!same(reference(record),reference(projected.record)))return null;
    let declarationGuards:Ref[]=[];
    if(record.value.scope.id.startsWith('om-obligations:')){
      const declared=omRuntimeAssignment(store,project,record.value.scope,record.value.requestedFor,true);
      if(!same(declared.assignment,assignment))return null;
      declarationGuards=declared.guards;
    }
    if(!declaredRuntimeSubjects(assignment.runtimeCheck,record.value.subjects))return null;
    // One admission basis for both modes: the live check recomputes every
    // field against today's state; the historical replay compares the same
    // basis between saved records.
    const liveBasis: RuntimeAdmissionBasis = {
      binding: current.binding,
      executable: { path: realpathSync(process.execPath), identity: runtimeExecutableIdentity(realpathSync(process.execPath)) },
      subjects: record.value.subjects.map(subject => {
        const path = runtimeSubjectPath(current.root, subject.requested, subject.kind);
        return { requested: subject.requested, kind: subject.kind, path, identity: runtimeExecutableIdentity(path) };
      }) };
    if(!same(liveBasis,runtimeAdmissionBasis(record.value)))return null;
    const code=runtimeCode(store,project,record.value.check,record.value.codeRoot);
    const full=new Evidence(store).observe(project,sourceRef,{kind:'json-pointer',pointer:''});
    if(!same(code,projected.code)||!same(full,projected.full))return null;
    return {record,code,full,guards:uniqueRefs([reference(record),sourceRef,...declarationGuards,...current.guards,...code.map(o=>o.source)]),
      admissionGuards:current.admissionGuards};
  }catch{return null;} // Malformed, stale or foreign provenance never becomes runtime support.
}

function runtimeInvalid(message: string): never { throw new EngineError('runtime_evidence_invalid',message); }
const sortedParts = (parts: readonly string[]): string[] => [...new Set(parts)].sort();

/** The live admission reference of one declared check: today's binding,
 * executable identity and every declared subject resolved under the current
 * root — the same fields a saved observation carries in its own basis. */
function liveRuntimeReference(current: ReturnType<typeof runtimeContext> | null, failure: string | null, check: RuntimeCheck): RuntimeAdmissionReference {
  if (!current) return { check, basis: null, unresolved: failure ?? 'runtime_context_unavailable' };
  try {
    const executable = realpathSync(process.execPath);
    const declared = [...check.subjects.map(requested => ({ requested, kind: 'file' as const })),
      ...check.executables.map(requested => ({ requested, kind: 'executable' as const }))];
    const subjects = declared.map(({ requested, kind }) => {
      const path = runtimeSubjectPath(current.root, requested, kind);
      return { requested, kind, path, identity: runtimeExecutableIdentity(path) };
    });
    return { check, basis: { binding: current.binding as RuntimeObservation['runtimeBinding'],
      executable: { path: executable, identity: runtimeExecutableIdentity(executable) }, subjects }, unresolved: null };
  } catch (error) { return { check, basis: null, unresolved: error instanceof EngineError ? error.code : 'runtime_subject_invalid' }; }
}
/** The components of a candidate's basis that differ from the reference. */
function basisMismatch(reference: RuntimeAdmissionReference, basis: RuntimeAdmissionBasis): string[] {
  if (!reference.basis) return [`reference:${reference.unresolved ?? 'unresolved'}`];
  const parts: string[] = [];
  if (!same(reference.basis.binding, basis.binding)) parts.push('binding');
  if (!same(reference.basis.executable, basis.executable)) parts.push('executable');
  if (reference.basis.subjects.length !== basis.subjects.length) parts.push('subjects');
  else reference.basis.subjects.forEach((subject, index) => { if (!same(subject, basis.subjects[index])) parts.push(`subjects/${index}`); });
  return parts;
}

/** THE ONE derivation of the runtime selection (№1971-4, №2000-5, №2141):
 * every cited Source of a runtime obligation that carries runtime-observation
 * provenance of this project is a candidate; its exact record must read (a lost
 * record is a typed refusal, never a silent exclusion); its own basis is
 * compared with the reference of its declared check — today's live admission
 * in the current mode, the saved reference of the material in the historical
 * mode — and it is admitted or excluded with the named components. The
 * historical mode additionally requires every candidate to match the saved
 * material exactly and every saved candidate to be cited. Selected proofs,
 * supporting quotes and guards follow in the D8.4c form. */
function deriveRuntimeSelection(store: Store, project: string, spec: FieldSpec, report: TechnicalReport, observations: Observation[],
  mode: SelectionMode): RuntimeSelection & { supports: SubjectSupport[] } {
  const proofs: RuntimeEvidence[] = [], supporting: Observation[] = [], guards: Ref[] = [], admissionGuards: TransactionGuard[] = [];
  const references: RuntimeAdmissionReference[] = [], candidates: RuntimeAdmissionCandidate[] = [], supports: SubjectSupport[] = [];
  const admission: RuntimeAdmission = { contract: RUNTIME_ADMISSION, references, candidates };
  const empty = { runtime: { proofs, supporting, guards, admissionGuards }, admission, supports };
  if (spec.obligationContract !== 'evidence-v1') return empty;
  let current: ReturnType<typeof runtimeContext> | null = null, failure: string | null = null;
  if (mode.kind === 'current') {
    try { current = runtimeContext(store, project); }
    catch (error) { failure = error instanceof EngineError ? error.code : 'runtime_context_unavailable'; }
  }
  const referenceOf = (check: RuntimeCheck): RuntimeAdmissionReference => {
    const known = references.find(item => same(item.check, check));
    if (known) return known;
    const found = mode.kind === 'current' ? liveRuntimeReference(current, failure, check)
      : mode.admission.references.find(item => same(item.check, check));
    if (!found) runtimeInvalid('The saved admission material has no reference for a declared runtime check');
    references.push(found);
    return found;
  };
  const met = new Set<number>();
  for (const obligation of spec.obligations ?? []) {
    const assignment = obligation.assignment, item = report.coverage?.find(c => c.obligation === obligation.id);
    if (assignment?.kind !== 'environment-confirmation' || !assignment.runtimeCheck || !item || !Array.isArray(item.designs)) continue;
    const designs = report.designs.filter(d => item.designs.includes(d.id) && d.consumer === obligation.consumer);
    for (const document of report.documents ?? []) {
      if (document.kind !== 'document-observation' || !document.designs.some(id => designs.some(d => d.id === id))
        || !Number.isSafeInteger(document.citation) || document.citation < 0) continue;
      const cited = observations[document.citation];
      if (!cited || !isRef(cited.source)) continue;
      // Three outcomes (№2173): a lost mandatory basis is an addressed refusal, an exclusion is a subject-matter reason
      // that re-derives from the same exact records, and only a full projection can become support.
      const projection = projectRuntimeCandidate(store, project, assignment, cited.source);
      if (projection.kind === 'lost')
        throw new EngineError('runtime_evidence_invalid', `A mandatory basis of a cited runtime observation is unavailable or damaged (${projection.reason}): ${projection.message}`,
          { ref: projection.ref, reason: projection.reason });
      if (projection.kind === 'excluded' && !projection.record) continue;
      const source = exact<Source>(store, cited.source, 'source')!;
      const record = projection.kind === 'support' ? projection.support.record : projection.record!;
      const support = projection.kind === 'support' ? projection.support : null;
      if (support && !declaredRuntimeSubjects(assignment.runtimeCheck, support.record.value.subjects))
        runtimeInvalid('The observed subjects differ from the declared runtime check');
      const expected = referenceOf(assignment.runtimeCheck), basis = runtimeAdmissionBasis(record.value);
      let mismatch = support ? basisMismatch(expected, basis) : [`projection:${(projection as { reason: string }).reason}`];
      const saved = mode.kind === 'historical' ? mode.admission.candidates.findIndex(candidate =>
        candidate.obligation === obligation.id && candidate.document === document.id && candidate.citation === document.citation) : -1;
      if (mode.kind === 'historical') {
        if (saved < 0) runtimeInvalid('A cited runtime candidate is missing from the saved admission material');
        // The recorded exclusions of today's admission: a superseding revision re-derives as its existence; a
        // current-filesystem finding is the recorded fact of the original admission (R6), proved at the first write.
        for (const part of mode.admission.candidates[saved]!.mismatch) {
          if (part.startsWith('head:')) {
            const [, id, revision] = part.split(':');
            const superseding = Number(revision);
            const cited = id === 'source' ? source : record;
            if (!Number.isInteger(superseding) || superseding <= cited.revision || !store.get(cited.id, superseding))
              runtimeInvalid('A recorded superseding revision of a runtime candidate is not proved');
            mismatch.push(part);
          } else if (part.startsWith('current:')) mismatch.push(part);
        }
        mismatch = sortedParts(mismatch);
      } else if (!mismatch.length && support) {
        // Today's admission alone: the cited Source and record must be the current heads, the declared code and the
        // full observation must still read as their exact revisions (R6 — never re-checked by history).
        const sourceHead = store.get<Source>(cited.source.id), recordHead = store.get<RuntimeObservation>(record.id);
        if (!sourceHead || sourceHead.revision !== source.revision) mismatch.push(`head:source:${sourceHead?.revision ?? 0}`);
        if (!recordHead || recordHead.revision !== record.revision) mismatch.push(`head:observation:${recordHead?.revision ?? 0}`);
        if (!mismatch.length) {
          try {
            if (record.value.scope.id.startsWith('om-obligations:')) {
              const declared = omRuntimeAssignment(store, project, record.value.scope, record.value.requestedFor, true);
              if (!same(declared.assignment, assignment)) mismatch.push('current:declaration');
              else guards.push(...declared.guards);
            }
            const code = runtimeCode(store, project, record.value.check, record.value.codeRoot);
            const full = new Evidence(store).observe(project, cited.source, { kind: 'json-pointer', pointer: '' });
            if (!same(code, support.code) || !same(full, support.full)) mismatch.push('current:code');
          } catch (error) { mismatch.push(`current:${error instanceof EngineError ? error.code : 'unavailable'}`); }
        }
        mismatch = sortedParts(mismatch);
      } else mismatch = sortedParts(mismatch);
      const candidate: RuntimeAdmissionCandidate = { obligation: obligation.id, document: document.id, citation: document.citation,
        observation: reference(record), source: cited.source, basis, admitted: mismatch.length === 0, mismatch };
      if (mode.kind === 'historical') {
        if (!same(mode.admission.candidates[saved], candidate)) runtimeInvalid('The saved admission material does not match its exact observation');
        met.add(saved);
      }
      candidates.push(candidate);
      if (!candidate.admitted || !support) continue;
      supports.push(support);
      proofs.push({ obligation: obligation.id, document: document.id, observation: reference(record), source: cited.source,
        authorization: record.value.scope, code: support.code.map(o => o.source) });
      guards.push(...support.guards, ...(current ? current.guards : []));
      if (current) admissionGuards.push(...current.admissionGuards);
      for (const extra of [support.full, ...support.code]) {
        const extraSource = exact<Source>(store, extra.source, 'source');
        if (!extraSource) runtimeInvalid('A supporting Source disappeared');
        if ([...observations, ...supporting].some(o => same(o.source, extra.source)
          && (o.selector.kind === 'json-pointer' && o.selector.pointer === ''
            || o.selector.kind === 'text-range' && o.selector.start === 0 && o.selector.end === extraSource.value.content.length))) continue;
        supporting.push(extra);
      }
    }
  }
  if (mode.kind === 'historical' && met.size !== mode.admission.candidates.length)
    runtimeInvalid('The saved admission material names candidates this report does not cite');
  return { runtime: { proofs, supporting, guards: uniqueRefs(guards), admissionGuards: uniqueTransactionGuards(admissionGuards) }, admission, supports };
}

/** The current admission: the runtime result in the D8.4c form together with
 * the admission material it was derived from, to be saved in M as one. */
export function collectRuntimeSelection(store: Store, project: string, spec: FieldSpec, report: TechnicalReport, observations: Observation[]): RuntimeSelection {
  const { runtime, admission } = deriveRuntimeSelection(store, project, spec, report, observations, { kind: 'current' });
  return { runtime, admission };
}
export function collectRuntimeEvidence(store: Store, project: string, spec: FieldSpec, report: TechnicalReport, observations: Observation[]) {
  return collectRuntimeSelection(store, project, spec, report, observations).runtime;
}

/** The admission material must be today's admission before M is written: the
 * full live derivation of the same report and citations must reproduce it and
 * the runtime result exactly — a stale, foreign or empty caller-supplied
 * result never becomes a paid origin (№2141, R6: the direct session entry). */
export function checkRuntimeAdmissionCurrent(store: Store, project: string, spec: FieldSpec, report: TechnicalReport,
  observations: Observation[], saved: RuntimeMaterials, admission: RuntimeAdmission): void {
  const live = deriveRuntimeSelection(store, project, spec, report, observations, { kind: 'current' });
  if (!same(live.admission, admission) || !same(live.runtime, saved))
    runtimeInvalid('The runtime admission material is not the current admission of this report');
}

/** Replay the collected result from exact original records and citation bytes.
 * With the saved admission material the selected and the excluded candidates
 * are derived from that material alone (historical mode); without it the
 * replay is the current derivation in the same environment. Saved
 * current-admission guards are checked as witnesses of that original binding;
 * no head, executable or filesystem is consulted for the selection itself. */
export function readRuntimeEvidenceAt(store: Store, project: string, spec: FieldSpec, report: TechnicalReport,
  observations: Observation[], saved: RuntimeMaterials, admission?: RuntimeAdmission): RuntimeMaterials {
  if (!spec || !Array.isArray(observations)
    || !saved || !Array.isArray(saved.proofs) || !Array.isArray(saved.supporting)
    || !Array.isArray(saved.guards) || !Array.isArray(saved.admissionGuards)
    || !saved.guards.every(isRef)) runtimeInvalid('The saved runtime result is incomplete');
  if (admission !== undefined && (!admission || admission.contract !== RUNTIME_ADMISSION
    || !Array.isArray(admission.references) || !Array.isArray(admission.candidates))) runtimeInvalid('The saved admission material is incomplete');
  if (spec.obligationContract !== 'evidence-v1') {
    if (!same(saved,{proofs:[],supporting:[],guards:[],admissionGuards:[]}))
      runtimeInvalid('A question without runtime obligations cannot carry runtime proof');
    if (admission && (admission.references.length || admission.candidates.length))
      runtimeInvalid('A question without runtime obligations cannot carry admission material');
    return saved;
  }
  if (!report || !Array.isArray(report.designs)) runtimeInvalid('Runtime obligations need their original technical report');
  // Every original citation participates in full-source deduplication below.
  // A forged unused citation must not suppress a generated supporting quote.
  try {
    for (const observation of observations) {
      const source=observation && exact<Source>(store,observation.source,'source');
      if (!source || !same(historicalObservation(store,project,observation),observation))
        throw new Error('The original citation differs from its Source');
    }
  } catch { runtimeInvalid('A saved runtime citation differs from its exact Source bytes'); }
  const derived = deriveRuntimeSelection(store, project, spec, report, observations,
    admission ? { kind: 'historical', admission } : { kind: 'current' });
  const { proofs, supporting } = derived.runtime, supports = derived.supports;
  if(!same(saved.proofs,proofs)||!same(saved.supporting,supporting))
    runtimeInvalid('The saved runtime proofs or supporting citations differ from their exact origins');
  if(!supports.length){
    if(!same(saved.guards,[])||!same(saved.admissionGuards,[]))runtimeInvalid('An empty runtime proof has unexpected guards');
    return {proofs,supporting,guards:[],admissionGuards:[]};
  }
  const mandatory=uniqueRefs(supports.flatMap(support=>support.guards)),extras=saved.guards.filter(guard=>!mandatory.some(ref=>same(ref,guard)));
  const one=(id:string):Ref|null=>{
    const matches=extras.filter(ref=>ref.id===id);
    if(matches.length>1)runtimeInvalid(`Multiple ${id} runtime guards`);
    return matches[0]??null;
  };
  const environment=one(`environment:${project}`),execution=one(`execution-root:${project}`),pilot=one(`reader-pilot:${project}`);
  if(!environment||extras.length!==[environment,execution,pilot].filter(Boolean).length)
    runtimeInvalid('The saved runtime guards contain a missing or foreign live binding');
  for(const support of supports){
    const record=support.record.value,binding=record.runtimeBinding as Record<string,unknown>;
    const env=exact<Record<string,unknown>>(store,environment,'environment');
    if(!env||!binding||typeof binding!=='object'||!same(binding.environment,env.value)
      ||!same(binding.root,record.root))runtimeInvalid('The saved runtime environment guard contradicts the observation');
    if(execution){
      const root=exact<Record<string,unknown>>(store,execution,'execution-root');
      const workspace=isRef(root?.value.workspace)
        ? exact<Record<string,unknown>>(store,root.value.workspace,'workspace'):null;
      if(!root||root.value.projectId!==project||root.value.state!=='ready'
        ||root.value.path!==record.root||root.value.sourceRoot!==env.value.workspace
        ||!workspace||workspace.value.path!==env.value.workspace)
        runtimeInvalid('The saved execution root contradicts the observation');
    }else if(record.root!==env.value.workspace)runtimeInvalid('The saved runtime lost its execution root guard');
    if(pilot){
      const configured=exact<Record<string,unknown>>(store,pilot,'reader-pilot');
      if(!configured||configured.value.projectId!==project
        ||!same(binding.pilot,configured.value.active
          ? {reader:configured.value.reader,agentCommand:configured.value.agentCommand,
              callTimeoutMs:configured.value.callTimeoutMs??null}:null))
        runtimeInvalid('The saved reader configuration contradicts the observation');
    }else if(binding.pilot!==null)runtimeInvalid('The saved runtime lost its reader guard');
  }
  const admissions=uniqueTransactionGuards([
    ...(!execution?[{id:`execution-root:${project}`,absent:true as const}]:[]),
    ...(!pilot?[{id:`reader-pilot:${project}`,absent:true as const}]:[])]);
  if(!same(saved.guards,uniqueRefs([...mandatory,...extras]))||!same(saved.admissionGuards,admissions))
    runtimeInvalid('The saved runtime guards do not derive from the original runtime binding');
  return saved;
}

/** These are persistent evidence dependencies. Current runtime configuration
 * refs are admission guards, not a reason to reinterpret an old observation. */
export function runtimeEvidenceDependencies(proofs:RuntimeEvidence[]):Ref[]{
  return uniqueRefs(proofs.flatMap(proof=>[proof.observation,proof.source,...proof.code]));
}

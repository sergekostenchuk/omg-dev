import { Store, checkTransactionGuards, storeObserved, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { provenStore } from "../storage/store-view.js";
import { EngineError, requireCondition } from "../errors.js";
import { canonical, hashJson, type Json } from "../canonical.js";
import { uniqueTransactionGuards, transactionGuardsCurrent } from "../runtime/environment.js";
import { sourceIsCurrent, withSourceMemo, type Source } from "../evidence/evidence.js";
import { STAGES, predecessor, reference, stageId, isRef, uniqueRefs, STAGE_CLOSURE_CONTRACT,
  type Stage, type StageArtifact, type StageClosure, type StageExternalCheck, type ExternalCheckHandler,
  type ExternalCheckHandlers, type StageProjection, type StageValidators, type Finding, type Ref,
  type AcceptedStageArtifact, type StageHistoryReader } from "./contracts.js";
export type { AcceptedStageArtifact } from './contracts.js';

interface PreparedStage { write: Write & { value: StageArtifact }; guards: TransactionGuard[] }

/** G1: validates one declared external check — unknown or malformed kinds make the closure itself
 * invalid (№6212 п.1: fields beyond the ones the contract names are kept, never dropped — later
 * contract versions may carry them). */
function externalCheckOf(value: unknown): StageExternalCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const check = value as Record<string, unknown>;
  const valid = (() => { switch (check['kind']) {
    case "source": case "om-feasibility": return isRef(check['ref']);
    case "graph-projection":
      return (check['level'] === 1 || check['level'] === 2 || check['level'] === 3)
        && typeof check['hash'] === "string" && check['hash'].length > 0;
    case "repository": case "environment": case "git-ancestry": return isRef(check['basis']);
    default: return false;
  } })();
  return valid ? check as unknown as StageExternalCheck : null;
}
function uniqueExternalChecks(checks: readonly StageExternalCheck[]): StageExternalCheck[] {
  return [...new Map(checks.map(check => [canonical(check), check])).values()];
}
/** G1 (№6201 п.1): the default executor registry the declared external checks of a closure run
 * through. G1 registers `source` alone — the exact source revision is re-read and sourceIsCurrent
 * applied to the file on disk. G2 plugs its handlers in by constructing the Pipeline with them;
 * a kind with no registered executor is never a silent pass — the closed read falls back to the
 * full inspection. */
const defaultExternalChecks: ExternalCheckHandlers = {
  source: (check, context) => {
    const source = context.store.get<Source>(check.ref.id, check.ref.revision);
    return source !== null && source.kind === "source" && source.hash === check.ref.hash
      && sourceIsCurrent(source.value)
      ? null : { code: "external_source_changed", target: check.ref.id,
        message: "The declared external source changed" };
  },
};
const EXTERNAL_CHECK_KINDS: readonly StageExternalCheck['kind'][] =
  ["source", "graph-projection", "repository", "environment", "git-ancestry", "om-feasibility"];
/** Execution consumes a sealed compilation version once its result is completed: its commits must not
 * make historical R3 evidence retroactively invalidate the completed result. Such an accepted execution
 * never re-inspects its compilation — and so (G1, №6254) neither inherits the compilation's external
 * checks nor keeps the compilation's admission among the conditions of its later reads. */
function sealedResult(stage: Stage, value: StageArtifact): boolean {
  const content = value.content;
  return stage === "execution" && content !== null && typeof content === "object" && !Array.isArray(content)
    && isRef((content as Record<string, unknown>)['result']);
}

export class Pipeline {
  #externalChecks: ExternalCheckHandlers;
  /** The admission the stage's own validator issued in one full inspection, apart from the predecessor's. */
  #ownAdmission = new WeakMap<StageProjection, TransactionGuard[]>();
  constructor(private readonly store: Store, private readonly validators: StageValidators,
    externalChecks?: ExternalCheckHandlers, private readonly historyReader?: StageHistoryReader) {
    requireCondition(STAGES.every(stage => typeof validators[stage] === "function"),
      "stage_contract_missing", "Every stage needs its own executable validation contract");
    // G1 (№6210): the caller's handlers merge over the defaults — a handler passed for a kind
    // replaces the default, `source` keeps its executor unless one is named. No global state.
    if (externalChecks !== undefined)
      requireCondition(typeof externalChecks === "object" && externalChecks !== null && !Array.isArray(externalChecks)
        && Object.entries(externalChecks).every(([kind, handler]) =>
          (EXTERNAL_CHECK_KINDS as readonly string[]).includes(kind) && typeof handler === "function"),
        "stage_contract_missing", "External check handlers name contract kinds and are functions");
    this.#externalChecks = externalChecks === undefined
      ? defaultExternalChecks : { ...defaultExternalChecks, ...externalChecks };
  }
  #requireProject(projectId: string): void {
    requireCondition(typeof projectId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(projectId), "invalid_project", "Project ID is invalid");
  }
  #requireStage(stage: Stage): void {
    requireCondition(STAGES.includes(stage), "unknown_stage", "Unknown pipeline stage");
  }
  /** One exact historical acceptance. The registered stage contract proves saved grounds; current heads/closure guards
   * are not acceptance evidence, and an unconnected historical contract refuses rather than trusting status. */
  async readAcceptedStageArtifactAt(projectId: string, stage: Stage, at: unknown): Promise<AcceptedStageArtifact> {
    this.#requireProject(projectId); this.#requireStage(stage);
    let ref: Ref;
    try { ref = JSON.parse(canonical(at)) as Ref; }
    catch { throw new EngineError('stage_history_invalid', 'Expected an exact JSON stage Ref'); }
    requireCondition(isRef(ref) && Object.keys(ref).sort().join(',') === 'hash,id,revision'
      && ref.id === stageId(projectId, stage), 'stage_history_invalid', 'Expected the exact stage Ref for this project and stage');
    const artifact = this.store.get<StageArtifact>(ref.id, ref.revision);
    requireCondition(artifact !== null && artifact.kind === 'stage' && canonical(reference(artifact)) === canonical(ref)
      && hashJson(artifact.value) === ref.hash && artifact.value?.projectId === projectId && artifact.value.stage === stage
      && artifact.value.status === 'accepted', 'stage_history_invalid', 'The exact accepted stage container is absent or foreign');
    requireCondition(this.historyReader !== undefined, 'stage_history_unsupported', 'This pipeline has no historical acceptance contract');
    const grounds = await this.historyReader(artifact);
    return structuredClone({ artifact, grounds: uniqueRefs(grounds) });
  }
  draft(projectId: string, stage: Stage, content: Json, expected: number, admissionGuards: TransactionGuard[] = []): Revision<StageArtifact> {
    const prepared = this.#prepareDraft(projectId, stage, content, expected, admissionGuards);
    return this.store.writeMany<StageArtifact>([prepared.write], prepared.guards)[0]!;
  }
  #prepareDraft(projectId: string, stage: Stage, content: Json, expected: number, admissionGuards: TransactionGuard[]): PreparedStage {
    this.#requireProject(projectId); this.#requireStage(stage);
    const prior = predecessor(stage);
    let input: Revision<StageArtifact> | null = null;
    const guards = uniqueTransactionGuards(admissionGuards);
    if (prior) {
      const projection = this.inspect(projectId, prior);
      requireCondition(projection.state === "accepted", "predecessor_not_ready", `${prior} must be accepted and current`);
      input = projection.artifact;
      guards.push(...projection.guards, ...(projection.admissionGuards ?? []));
    }
    return { write: {
      id: stageId(projectId, stage), kind: "stage", expected,
      value: { projectId, stage, status: "draft", content, inputs: input ? [reference(input)] : [], proofs: [] },
    }, guards: uniqueTransactionGuards(guards) };
  }
  inspect(projectId: string, stage: Stage): StageProjection {
    return withSourceMemo(() => {
      this.#requireProject(projectId); this.#requireStage(stage);
      const artifact = this.store.get<StageArtifact>(stageId(projectId, stage));
      if (!artifact) return { stage, state: "missing", artifact: null, findings: [], guards: [] };
      return this.#inspectValue(projectId, stage, artifact.value, artifact);
    });
  }
  #inspectValue(projectId: string, stage: Stage, value: StageArtifact, artifact: Revision<StageArtifact> | null): StageProjection {
    const id = stageId(projectId, stage);
    requireCondition(value && typeof value === "object" && !Array.isArray(value), "artifact_invalid", "Stage artifact must be an object");
    requireCondition((!artifact || artifact.kind === "stage") && value.projectId === projectId && value.stage === stage,
      "foreign_artifact", "Stored artifact does not belong to this stage");
    requireCondition(["draft", "accepted"].includes(value.status)
      && Object.hasOwn(value, "content") && Array.isArray(value.inputs) && value.inputs.every(isRef)
      && Array.isArray(value.proofs) && value.proofs.every(isRef),
    "artifact_invalid", "Stored stage artifact has missing or malformed fields");
    // G1: an accepted artifact with a recorded closure is checked by one snapshot of heads plus its
    // declared external checks — the stage validator does not run, and the predecessor is not
    // re-inspected. Any miss falls through to the full inspection below, which names the same
    // findings as before; a malformed closure is an addressed refusal, not a miss.
    if (artifact && value.status === "accepted" && value.closure !== undefined) {
      const closed = this.#closedProjection(projectId, stage, value, artifact);
      if (closed) return closed;
    }
    const findings: Finding[] = [];
    const guards: Ref[] = artifact ? [reference(artifact)] : [];
    const admissionGuards: TransactionGuard[] = [];
    const inputs: Revision<StageArtifact>[] = [];
    const prior = predecessor(stage);
    if (value.inputs.length !== (prior ? 1 : 0)) findings.push({ code: "input_set_invalid", target: id, message: "Stage input set is incomplete or contains extras" });
    if (prior) {
      // Execution consumes a sealed compilation version. Its commits must not make
      // historical R3 evidence retroactively invalidate the completed result.
      const sealed = value.status === "accepted" && sealedResult(stage, value)
        ? this.store.get<StageArtifact>(stageId(projectId, prior)) : null;
      const current = sealed ? { state: sealed.value.status, artifact: sealed, guards: [reference(sealed)] } : this.inspect(projectId, prior);
      guards.push(...current.guards);
      admissionGuards.push(...('admissionGuards' in current ? current.admissionGuards ?? [] : []));
      const expected = value.inputs[0];
      if (current.state !== "accepted" || !expected || !current.artifact
        || expected.id !== stageId(projectId, prior) || expected.hash !== current.artifact.hash
        || expected.revision !== current.artifact.revision) {
        findings.push({ code: "input_stale", target: stageId(projectId, prior), message: "A prerequisite changed; revise this stage against its current version" });
      } else inputs.push(current.artifact);
    }
    for (const proof of uniqueRefs(value.proofs)) {
      const current = this.store.get(proof.id);
      if (!current || current.hash !== proof.hash || current.revision !== proof.revision) findings.push({ code: "proof_stale", target: proof.id, message: "The evidence used by this stage has changed" });
      else guards.push(reference(current));
    }
    if (findings.length) return { stage, state: value.status === "accepted" ? "stale" : "blocked", artifact, findings, guards: uniqueRefs(guards),
      ...(admissionGuards.length ? { admissionGuards: uniqueTransactionGuards(admissionGuards) } : {}) };
    const validation = this.validators[stage]({ projectId, content: value.content, inputs, accepted: value.status === "accepted" });
    findings.push(...validation.findings);
    guards.push(...validation.guards);
    admissionGuards.push(...(validation.admissionGuards ?? []));
    if (!findings.length && admissionGuards.length && !transactionGuardsCurrent(this.store, [...guards, ...admissionGuards]))
      findings.push({ code: "input_stale", target: id, message: "An admission dependency changed while this stage was checked" });
    const state = findings.length ? (value.status === "accepted" ? "stale" : "blocked") : value.status;
    const projection: StageProjection = { stage, state, artifact, findings, guards: uniqueRefs(guards),
      ...(admissionGuards.length ? { admissionGuards: uniqueTransactionGuards(admissionGuards) } : {}),
      ...(validation.closure !== undefined ? { closure: validation.closure } : {}) };
    this.#ownAdmission.set(projection, uniqueTransactionGuards(validation.admissionGuards ?? []));
    return projection;
  }
  /**
   * G1: reads an accepted artifact's recorded closure — one snapshot comparing the heads of its proofs
   * and admission guards (absent requirements included; on opaque views and inside an active capture
   * the same guards are compared by observable gets), then its declared external checks, both its own
   * and the ones inherited from the predecessor's closure. A breached saved guard is the stale refusal
   * itself, on every path (№6232 G1-01); a missed external check returns null — the caller falls back
   * to the full inspection, which names the same findings and codes as before. A malformed closure
   * answers `stage_closure_invalid` instead of falling back: an addressed refusal, not a change of
   * basis (№6174 п.1).
   */
  #closedProjection(projectId: string, stage: Stage, value: StageArtifact, artifact: Revision<StageArtifact>): StageProjection | null {
    const id = stageId(projectId, stage);
    const closure = value.closure;
    const invalid = (message: string): StageProjection => ({
      stage, state: "stale", artifact,
      findings: [{ code: "stage_closure_invalid", target: id, message }],
      guards: uniqueRefs([reference(artifact), ...value.proofs]) });
    if (!closure || typeof closure !== "object" || Array.isArray(closure)
      || closure.contract !== STAGE_CLOSURE_CONTRACT
      || !Array.isArray(closure.proofs) || !closure.proofs.every(isRef)
      || canonical(closure.proofs) !== canonical(value.proofs)
      || !Array.isArray(closure.inherited) || closure.inherited.some(check => externalCheckOf(check) === null)
      || !Array.isArray(closure.external) || closure.external.some(check => externalCheckOf(check) === null)
      || !Array.isArray(closure.admission) || !Array.isArray(closure.writeGuards))
      return invalid("The recorded stage closure is malformed");
    try { checkTransactionGuards(closure.admission); checkTransactionGuards(closure.writeGuards); }
    catch (error) {
      if (error instanceof EngineError && error.code === "invalid_guard")
        return invalid("The recorded stage closure carries malformed guards");
      throw error;
    }
    // The saved proofs and admission are the conditions of THIS acceptance on every read path
    // (№6232 G1-01): a breach is the stale refusal itself — the diagnostic fallback below may not
    // launder it into a fresh validator admission. One heads snapshot answers on a proved Store while
    // no capture is observing; every other store or view, and every read a proof is already tracing,
    // checks the same guards by observable gets so the journal keeps the reads the old path always made.
    const source = provenStore(this.store);
    const stale = (findings: Finding[]): StageProjection => ({ stage, state: "stale", artifact,
      findings, guards: uniqueRefs([reference(artifact), ...value.proofs]),
      ...(closure.admission.length ? { admissionGuards: [...closure.admission] } : {}) });
    if (source && !storeObserved(source)) {
      const match = source.headsMatch([...closure.proofs, ...closure.admission]);
      if (!match.ok) {
        const proofIds = new Set(closure.proofs.map(ref => ref.id));
        return stale(match.mismatches.map(miss => proofIds.has(miss.id)
          ? { code: "proof_stale", target: miss.id, message: "The evidence used by this stage has changed" }
          : { code: "input_stale", target: miss.id,
            message: "An admission dependency of the recorded acceptance changed" }));
      }
    } else {
      const findings: Finding[] = [];
      const flagged = new Set<string>();
      for (const proof of closure.proofs) {
        const current = this.store.get(proof.id);
        if (!current || current.revision !== proof.revision || current.hash !== proof.hash) {
          flagged.add(proof.id);
          findings.push({ code: "proof_stale", target: proof.id, message: "The evidence used by this stage has changed" });
        }
      }
      for (const guard of closure.admission) {
        const current = this.store.get(guard.id);
        const held = 'absent' in guard ? current === null
          : current !== null && current.revision === guard.revision && current.hash === guard.hash;
        if (!held && !flagged.has(guard.id))
          findings.push({ code: "input_stale", target: guard.id,
            message: "An admission dependency of the recorded acceptance changed" });
      }
      if (findings.length) return stale(findings);
    }
    // One source is checked once per read, however many stages in the prefix declared it (№6174 п.2).
    const context = { store: this.store, projectId, stage };
    for (const check of uniqueExternalChecks([...closure.inherited, ...closure.external])) {
      const handler = this.#externalChecks[check.kind] as ExternalCheckHandler | undefined;
      // A kind with no registered executor — and any miss of a live dependency — falls back to the
      // full inspection: never a silent pass, and the sealed exceptions and verbatim findings the
      // old path names are preserved (№6201 п.1).
      const outcome = handler ? handler(check, context) : null;
      // A saved-admission breach observed inside an executor's own read window is the stale refusal
      // itself (№6232 G1-01): falling back would launder it into a fresh admission the new head
      // cannot breach. Every other miss still falls back to the full inspection below.
      if (outcome !== null && outcome.code === "input_stale") return stale([outcome]);
      if (!handler || outcome !== null) return null;
    }
    return { stage, state: "accepted", artifact, findings: [],
      guards: uniqueRefs([reference(artifact), ...value.proofs]),
      ...(closure.admission.length ? { admissionGuards: closure.admission } : {}) };
  }
  /**
   * Builds the closure of a stage being accepted — only when its validator issued an explicit
   * declaration. A predecessor's external surface is covered by inheriting its recorded closure; an
   * accepted predecessor without one leaves that surface unknown, so this stage stays unclosed as well
   * (absence of a declaration is never an empty list — №6174 п.1–2). `writeGuards` are the guards of the
   * acceptance write itself — the previous stage revision, the current graph head, the caller's extras —
   * recorded as an audit of the commit, never as proofs.
   */
  #closureValue(value: StageArtifact, checked: StageProjection,
    writeGuards: TransactionGuard[]): StageClosure | null {
    const declaration = checked.closure;
    if (declaration === undefined) return null;
    requireCondition(declaration !== null && typeof declaration === "object" && !Array.isArray(declaration)
      && declaration.contract === STAGE_CLOSURE_CONTRACT && Array.isArray(declaration.external),
      "stage_closure_invalid", "The stage validator issued a malformed closure declaration");
    const external = declaration.external.map((check, index) => {
      const normalized = externalCheckOf(check);
      requireCondition(normalized !== null, "stage_closure_invalid",
        `The stage validator declared a malformed external check ${index}`);
      return normalized;
    });
    const prior = value.inputs[0];
    const inherited: StageExternalCheck[] = [];
    // A sealed execution's later reads never re-inspect its compilation (the full path guards only its
    // head): its closure inherits none of the compilation's external checks and records only the
    // admission its own validator issued — never a historical repository or source check (№6254).
    const sealed = sealedResult(value.stage, value);
    if (prior && !sealed) {
      const predecessorArtifact = this.store.get<StageArtifact>(prior.id, prior.revision);
      const priorClosure = predecessorArtifact?.value.closure;
      // A malformed prior closure does not poison this stage's own — the predecessor's unknown
      // external surface leaves this stage unclosed, like a missing declaration would.
      if (!priorClosure || typeof priorClosure !== "object" || Array.isArray(priorClosure)
        || priorClosure.contract !== STAGE_CLOSURE_CONTRACT
        || !Array.isArray(priorClosure.inherited) || !Array.isArray(priorClosure.external)) return null;
      for (const check of [...priorClosure.inherited, ...priorClosure.external]) {
        const normalized = externalCheckOf(check);
        if (normalized === null) return null;
        inherited.push(normalized);
      }
    }
    const own = this.#ownAdmission.get(checked);
    requireCondition(!sealed || own !== undefined, "stage_closure_invalid",
      "A sealed execution's closure needs the admission of its own full inspection");
    // The positive read-commit pin of this project's dispatch counter is a condition of the
    // acceptance write itself, never of later reads: it stays in the write guards (and so keeps
    // guarding the atomic commit) but a legitimate later dispatch must not make the stage stale.
    // Every fresh scan pins the counter anew before returning.
    const dispatchPin = `project-dispatch:${hashJson(value.projectId)}`;
    const admission = (sealed ? [...own!] : [...(checked.admissionGuards ?? [])])
      .filter(guard => "absent" in guard || guard.id !== dispatchPin);
    return { contract: STAGE_CLOSURE_CONTRACT, proofs: [],
      admission,
      inherited: uniqueExternalChecks(inherited), external,
      writeGuards: [...writeGuards] };
  }
  #acceptedValue(value: StageArtifact, checked: StageProjection, writeGuards: TransactionGuard[]): StageArtifact {
    const accepted: StageArtifact = { ...value, status: "accepted",
      proofs: checked.guards.filter(ref => ref.id !== stageId(value.projectId, value.stage)) };
    const closure = this.#closureValue(value, checked, writeGuards);
    if (closure) { closure.proofs = accepted.proofs; accepted.closure = closure; }
    else delete accepted.closure;
    return accepted;
  }
  prepareAccepted(projectId: string, stage: Stage, content: Json, expected: number, extraGuards: TransactionGuard[] = []): PreparedStage {
    this.#requireProject(projectId); this.#requireStage(stage);
    requireCondition(Number.isSafeInteger(expected) && expected >= 0, "invalid_write", "An explicit expected revision is required");
    const prepared = this.#prepareDraft(projectId, stage, JSON.parse(canonical(content)) as Json, expected, extraGuards);
    const checked = this.#inspectValue(projectId, stage, prepared.write.value, null);
    if (checked.findings.length) throw new EngineError("gate_rejected", "Stage validation refused acceptance", checked.findings);
    const guards = uniqueTransactionGuards([...prepared.guards, ...checked.guards, ...(checked.admissionGuards ?? [])]);
    return {
      write: { ...prepared.write, value: this.#acceptedValue(prepared.write.value, checked, guards) },
      guards,
    };
  }
  accept(projectId: string, stage: Stage, expected: number, extraGuards: TransactionGuard[] = []): Revision<StageArtifact> {
    const checked = this.inspect(projectId, stage);
    requireCondition(checked.artifact && checked.artifact.revision === expected, "revision_conflict", "Stage changed; reload before accepting");
    if (checked.findings.length) throw new EngineError("gate_rejected", "Stage validation refused acceptance", checked.findings);
    if (checked.state === "accepted") return checked.artifact;
    requireCondition(checked.state === "draft", "stage_not_ready", "Stage is not ready for acceptance");
    const guards = uniqueTransactionGuards([...checked.guards, ...(checked.admissionGuards ?? []), ...extraGuards]);
    return this.store.writeMany<StageArtifact>([{
      id: checked.artifact.id, kind: "stage", expected,
      value: this.#acceptedValue(checked.artifact.value, checked, guards),
    }], guards)[0]!;
  }
  project(projectId: string): StageProjection[] {
    return withSourceMemo(() => STAGES.map(stage => this.inspect(projectId, stage)));
  }
}

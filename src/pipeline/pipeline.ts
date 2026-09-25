import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { EngineError, requireCondition } from "../errors.js";
import { canonical, type Json } from "../canonical.js";
import { uniqueTransactionGuards, transactionGuardsCurrent } from "../runtime/environment.js";
import { STAGES, predecessor, reference, stageId, isRef, uniqueRefs, type Stage, type StageArtifact,
  type StageProjection, type StageValidators, type Finding, type Ref } from "./contracts.js";

interface PreparedStage { write: Write & { value: StageArtifact }; guards: TransactionGuard[] }

export class Pipeline {
  constructor(private readonly store: Store, private readonly validators: StageValidators) {
    requireCondition(STAGES.every(stage => typeof validators[stage] === "function"),
      "stage_contract_missing", "Every stage needs its own executable validation contract");
  }
  #requireProject(projectId: string): void {
    requireCondition(typeof projectId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(projectId), "invalid_project", "Project ID is invalid");
  }
  #requireStage(stage: Stage): void {
    requireCondition(STAGES.includes(stage), "unknown_stage", "Unknown pipeline stage");
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
    this.#requireProject(projectId); this.#requireStage(stage);
    const artifact = this.store.get<StageArtifact>(stageId(projectId, stage));
    if (!artifact) return { stage, state: "missing", artifact: null, findings: [], guards: [] };
    return this.#inspectValue(projectId, stage, artifact.value, artifact);
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
    const findings: Finding[] = [];
    const guards: Ref[] = artifact ? [reference(artifact)] : [];
    const admissionGuards: TransactionGuard[] = [];
    const inputs: Revision<StageArtifact>[] = [];
    const prior = predecessor(stage);
    if (value.inputs.length !== (prior ? 1 : 0)) findings.push({ code: "input_set_invalid", target: id, message: "Stage input set is incomplete or contains extras" });
    if (prior) {
      // Execution consumes a sealed compilation version. Its commits must not make
      // historical R3 evidence retroactively invalidate the completed result.
      const completedResult = value.content && typeof value.content === "object" && !Array.isArray(value.content)
        ? value.content['result'] : null;
      const sealed = stage === "execution" && value.status === "accepted" && isRef(completedResult)
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
    return { stage, state, artifact, findings, guards: uniqueRefs(guards),
      ...(admissionGuards.length ? { admissionGuards: uniqueTransactionGuards(admissionGuards) } : {}) };
  }
  #acceptedValue(value: StageArtifact, guards: Ref[]): StageArtifact {
    return { ...value, status: "accepted", proofs: guards.filter(ref => ref.id !== stageId(value.projectId, value.stage)) };
  }
  prepareAccepted(projectId: string, stage: Stage, content: Json, expected: number, extraGuards: TransactionGuard[] = []): PreparedStage {
    this.#requireProject(projectId); this.#requireStage(stage);
    requireCondition(Number.isSafeInteger(expected) && expected >= 0, "invalid_write", "An explicit expected revision is required");
    const prepared = this.#prepareDraft(projectId, stage, JSON.parse(canonical(content)) as Json, expected, extraGuards);
    const checked = this.#inspectValue(projectId, stage, prepared.write.value, null);
    if (checked.findings.length) throw new EngineError("gate_rejected", "Stage validation refused acceptance", checked.findings);
    return {
      write: { ...prepared.write, value: this.#acceptedValue(prepared.write.value, checked.guards) },
      guards: uniqueTransactionGuards([...prepared.guards, ...checked.guards, ...(checked.admissionGuards ?? [])]),
    };
  }
  accept(projectId: string, stage: Stage, expected: number, extraGuards: TransactionGuard[] = []): Revision<StageArtifact> {
    const checked = this.inspect(projectId, stage);
    requireCondition(checked.artifact && checked.artifact.revision === expected, "revision_conflict", "Stage changed; reload before accepting");
    if (checked.findings.length) throw new EngineError("gate_rejected", "Stage validation refused acceptance", checked.findings);
    if (checked.state === "accepted") return checked.artifact;
    requireCondition(checked.state === "draft", "stage_not_ready", "Stage is not ready for acceptance");
    return this.store.writeMany<StageArtifact>([{
      id: checked.artifact.id, kind: "stage", expected,
      value: this.#acceptedValue(checked.artifact.value, checked.guards),
    }], uniqueTransactionGuards([...checked.guards, ...(checked.admissionGuards ?? []), ...extraGuards]))[0]!;
  }
  project(projectId: string): StageProjection[] { return STAGES.map(stage => this.inspect(projectId, stage)); }
}

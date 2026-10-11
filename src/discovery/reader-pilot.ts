import { phasePolicy } from "./phase-policy.js";
import { Ajv } from "ajv";
import type { Store, Revision, TransactionGuard, Write } from "../storage/store.js";
import { executablePath, type Environment, type RoleBinding, type Environments } from "../runtime/environment.js";
import type { Command } from "../graph/model.js";
import { requireCondition, EngineError } from "../errors.js";
import { isRef, reference, stageId, type Ref, type StageArtifact } from "../pipeline/contracts.js";
import { canonical } from "../canonical.js";
import type { ModelCall } from "../runtime/model-usage.js";

export interface ReaderPilotSettings {
  experimental: true; active: boolean; stopAfter: "L2";
  reader: RoleBinding; agentCommand: Command;
  maxRequestChars: number; maxReadChars: number; maxReplyChars: number;
  maxExtractedChars?: number;
  maxCalls: number; maxReportedTokens: number;
  callTimeoutMs?: number;
  maxContinuationChars?: number;
  conclusionShare?: number;
  contextLimits?: { maxLookups: number; maxChars: number };
  physicalLimits?: { maxRequestChars: number; maxReplyChars: number; basis: string };
  planning?: { fields: string[]; maxRequestChars: number; maxRounds: number };
  unknownReserves?: { call: Ref; tokens: number }[];
  execution?: ExecutionAdmissionSettings;
}
/**
 * EX1 (№3945, №3951): the owner's admission of one exact accepted plan beyond the compilation boundary, with its execution
 * budget. Each revision of the pilot is a decision of its own; an earlier one is never erased. EX3 (№4000): a task may be
 * corrected up to three times in all — the limit counts the corrections already used, so no revision resets it. EX4 (№4016):
 * the owner may address one exact task of this plan its own limit in all, in place of the ordinary one — an absolute
 * value, so a later revision restates it rather than adds to it. EX6 (№4068): the owner may clarify the contract of one
 * exact task of this plan — a decision the accepted plan leaves open — with no recompilation: the plan, its task ids and
 * the spent budget stay as they are.
 */
export interface ExecutionAdmissionSettings {
  plan: Ref; roleLaunches: number; softInput: number; roleReserve: { implement: number; review: number }; maxCorrections: 0 | 1 | 2 | 3;
  taskCorrections?: TaskCorrectionLimit[]; taskClarifications?: TaskClarification[];
}
export interface TaskCorrectionLimit { task: string; maxCorrections: number }
export interface TaskClarification { task: string; text: string }
/** The admission an execution runs under: the exact pilot revision and its settings, a copy. */
export interface ExecutionAdmission { readonly pilot: Ref; readonly execution: ExecutionAdmissionSettings }
export interface ReaderPilot extends ReaderPilotSettings { projectId: string }
const text = { type: "string", minLength: 1 };
const positive = { type: "integer", minimum: 1 };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const command = object({ executable: text, args: { type: "array", items: { type: "string" } } });
export const readerPilotSchema = object({ experimental: { const: true }, active: { type: "boolean" }, stopAfter: { const: "L2" },
  reader: object({ actor: text, model: text, effort: { enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    speed: { enum: ["fast", "inherited"] }, command }), agentCommand: command,
  maxRequestChars: positive, maxReadChars: positive, maxReplyChars: positive, maxCalls: positive, maxReportedTokens: positive });
readerPilotSchema.properties['unknownReserves'] = { type: "array", items: object({ call: object({ id: text, revision: positive,
  hash: { type: "string", pattern: "^[a-f0-9]{64}$" } }), tokens: positive }) };
readerPilotSchema.properties['maxContinuationChars'] = positive;
readerPilotSchema.properties['conclusionShare'] = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 };
readerPilotSchema.properties['maxExtractedChars'] = positive;
readerPilotSchema.properties['contextLimits'] = object({ maxLookups: positive, maxChars: positive });
readerPilotSchema.properties['physicalLimits'] = object({ maxRequestChars: positive, maxReplyChars: positive, basis: text });
readerPilotSchema.properties['planning'] = object({ fields: { type: "array", minItems: 1, uniqueItems: true, items: text },
  maxRequestChars: positive, maxRounds: positive });
readerPilotSchema.properties['callTimeoutMs'] = { type: "integer", minimum: 1, maximum: 3_000_000 };
const executionSchema = object({ plan: object({ id: text, revision: positive, hash: { type: "string", pattern: "^[a-f0-9]{64}$" } }),
  roleLaunches: positive, softInput: positive, roleReserve: object({ implement: positive, review: positive }),
  maxCorrections: { type: "integer", minimum: 0, maximum: 3 } });
executionSchema.properties['taskCorrections'] = { type: "array", minItems: 1,
  items: object({ task: text, maxCorrections: { type: "integer", minimum: 0 } }) };
executionSchema.properties['taskClarifications'] = { type: "array", minItems: 1, items: object({ task: text, text }) };
readerPilotSchema.properties['execution'] = executionSchema;
const valid = new Ajv({ allErrors: true }).compile<ReaderPilotSettings>(readerPilotSchema);
const validExecution = new Ajv({ allErrors: true }).compile<ExecutionAdmissionSettings>(executionSchema);

/**
 * The one derivation of an execution admission's basis, shared by its writer and every reader: the phase policy stops
 * exactly at compilation and the accepted compilation stage holds exactly this plan, and every addressed correction limit
 * (EX4) and clarification (EX6) names a task of exactly this plan, once. The heads are captured before they are checked; they guard the admission's
 * write. The plan's own currency (the gate before an execution root exists, the execution's own progress after) is proved
 * by the caller's plan reader, never by the gate alone after a commit (№3953-1).
 */
export function executionAdmissionBasis(store: Store, project: string,
  execution: Pick<ExecutionAdmissionSettings, "plan" | "taskCorrections" | "taskClarifications">): TransactionGuard[] {
  const { plan } = execution;
  const policy = store.get(`phase-policy:${project}`), stage = store.get<StageArtifact>(stageId(project, "compilation"));
  const record = isRef(plan) ? store.get<{ projectId?: unknown; tasks?: { id?: unknown }[] }>(plan.id, plan.revision) : null;
  if (!isRef(plan) || !record || record.kind !== "plan" || record.hash !== plan.hash || record.value?.projectId !== project)
    throw new EngineError("execution_admission_invalid", "An execution admission names an exact plan of its project", { target: project, field: "execution.plan" });
  const tasks = new Set((record.value.tasks ?? []).map(task => task.id));
  for (const field of ["taskCorrections", "taskClarifications"] as const) {
    const addressed: readonly { task: string }[] = execution[field] ?? [];
    addressed.forEach((entry, index) => {
      if (!tasks.has(entry.task) || addressed.findIndex(other => other.task === entry.task) !== index)
        throw new EngineError("execution_admission_invalid", "An addressed setting names a task of exactly this plan, once",
          { target: project, field: `execution.${field}.${index}.task`, task: entry.task });
    });
  }
  requireCondition(phasePolicy(store, project)?.value.stopAfter === "compilation", "execution_admission_stale",
    "Execution is admitted only beyond a phase policy that stops at compilation");
  requireCondition(stage?.kind === "stage" && stage.value.projectId === project && stage.value.stage === "compilation" && stage.value.status === "accepted"
    && canonical((stage.value.content as unknown as { plan?: unknown } | null)?.plan ?? null) === canonical(plan),
  "execution_admission_stale", "Execution is admitted only for the plan of the accepted compilation stage");
  return [reference(policy!), reference(stage), plan];
}

/** Prepares a pilot revision without writing: the write and the guards of its one transaction. */
export function prepareReaderPilot(store: Store, environments: Environments, project: string, settings: unknown, expected: number,
  planCurrent?: (plan: Ref) => readonly TransactionGuard[]): { write: Write; guards: TransactionGuard[] } {
  const execution = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? (settings as { execution?: unknown }).execution : undefined;
  if (execution !== undefined && !validExecution(execution))
    throw new EngineError("execution_admission_invalid", "An execution admission needs its exact plan, budget, reserves and correction limit",
      { target: project, field: "execution", errors: validExecution.errors });
  if (!valid(settings)) throw new EngineError("reader_pilot_invalid", "The experiment requires explicit roles, limits and its L2 stop boundary", valid.errors);
  const env = environments.get(project).value;
  requireCondition(settings.reader.actor !== env.implementer.actor && settings.reader.actor !== env.reviewer.actor,
    "reader_role_invalid", "The reader must have its own identity and cannot accept its extraction");
  executablePath(settings.reader.command, env.workspace); executablePath(settings.agentCommand, env.workspace);
  const reserves = settings.unknownReserves ?? [];
  requireCondition(new Set(reserves.map(reserve => reserve.call.id)).size === reserves.length, "reader_pilot_invalid", "A call can have one explicit unknown-usage reserve");
  for (const reserve of reserves) {
    const call = isRef(reserve.call) ? store.get<ModelCall>(reserve.call.id) : null;
    requireCondition(call?.kind === "model-call" && call.value.projectId === project && call.value.status !== "running" && call.value.usage === null
      && call.value.profile?.id === `reader-pilot:${project}` && call.revision === reserve.call.revision && call.hash === reserve.call.hash,
      "usage_reserve_invalid", "A reserve must address an exact completed unmeasured call of this experiment");
  }
  let guards: TransactionGuard[] = [];
  if (settings.execution) {
    guards = executionAdmissionBasis(store, project, settings.execution);
    if (!planCurrent) throw new EngineError("execution_admission_invalid", "An execution admission is written only with its plan's currency proof",
      { target: project, field: "execution.plan" });
    guards.push(...planCurrent(settings.execution.plan));
  }
  return { write: { id: `reader-pilot:${project}`, kind: "reader-pilot", expected, value: { ...settings, projectId: project } as never }, guards };
}
export function configureReaderPilot(store: Store, environments: Environments, project: string, settings: unknown, expected: number,
  planCurrent?: (plan: Ref) => readonly TransactionGuard[]): Revision<ReaderPilot> {
  const prepared = prepareReaderPilot(store, environments, project, settings, expected, planCurrent);
  return store.writeMany<ReaderPilot>([prepared.write], prepared.guards)[0]!;
}

export function readerPilot(store: Store, project: string): Revision<ReaderPilot> | null {
  const record = store.get<ReaderPilot>(`reader-pilot:${project}`);
  if (!record) return null;
  requireCondition(record.kind === "reader-pilot" && record.value.projectId === project, "reader_pilot_invalid", "Foreign pilot configuration");
  const { projectId: _projectId, ...settings } = record.value;
  requireCondition(valid(settings), "reader_pilot_invalid", "Stored pilot configuration is invalid");
  return record.value.active ? record : null;
}

/**
 * The continuation boundary. Execution beyond a policy that stops at compilation passes only under the owner's admission
 * of exactly this plan, read by the same basis its writer proved (EX1); the admission is returned, and without a policy or
 * pilot there is none (the earlier era executes as before).
 */
export function assertPilotBoundary(store: Store, project: string, phase: string, plan?: Ref): ExecutionAdmission | null {
  const policy = phasePolicy(store, project);
  const pilot = readerPilot(store, project);
  const configured = store.get(`reader-pilot:${project}`);
  if (policy && policy.value.stopAfter !== "L2") requireCondition(pilot, "phase_protections_missing", "Continuation cannot disable its context and budget preset");
  const admitted = pilot?.value.execution;
  if (phase === "execution" && policy?.value.stopAfter === "compilation" && admitted && plan !== undefined && canonical(admitted.plan) === canonical(plan)) {
    executionAdmissionBasis(store, project, admitted);
    return { pilot: reference(pilot!), execution: structuredClone(admitted) };
  }
  requireCondition(!(policy || configured) || !(policy?.value.stopAfter === "compilation" ? ["execution"] : policy?.value.stopAfter === "L3" ? ["R3", "execution"] : ["R2", "L3", "R3", "execution"]).includes(phase),
    "pilot_boundary_reached", "This phase is beyond the explicitly permitted continuation boundary");
  return null;
}

/** The source environment stays unchanged so accepted source/assessment history
 * retains its original references. New attempts record the pilot separately. */
export function pilotEnvironment(environment: Environment, pilot: ReaderPilot): Environment {
  return { ...environment, timeoutMs: pilot.callTimeoutMs ?? environment.timeoutMs,
    implementer: { ...environment.implementer, command: pilot.agentCommand },
    reviewer: { ...environment.reviewer, command: pilot.agentCommand } };
}

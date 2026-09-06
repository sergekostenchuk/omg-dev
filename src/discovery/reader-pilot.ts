import { Ajv } from "ajv";
import type { Store, Revision } from "../storage/store.js";
import { executablePath, type Environment, type RoleBinding, type Environments } from "../runtime/environment.js";
import type { Command } from "../graph/model.js";
import { requireCondition, EngineError } from "../errors.js";
import { isRef, type Ref } from "../pipeline/contracts.js";
import type { ModelCall } from "../runtime/model-usage.js";

export interface ReaderPilotSettings {
  experimental: true; active: boolean; stopAfter: "L2";
  reader: RoleBinding; agentCommand: Command;
  maxRequestChars: number; maxReadChars: number; maxReplyChars: number;
  maxCalls: number; maxReportedTokens: number;
  callTimeoutMs?: number;
  planning?: { fields: string[]; maxRequestChars: number; maxRounds: number };
  unknownReserves?: { call: Ref; tokens: number }[];
}
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
readerPilotSchema.properties['planning'] = object({ fields: { type: "array", minItems: 1, uniqueItems: true, items: text },
  maxRequestChars: positive, maxRounds: positive });
readerPilotSchema.properties['callTimeoutMs'] = { type: "integer", minimum: 1, maximum: 3_000_000 };
const valid = new Ajv({ allErrors: true }).compile<ReaderPilotSettings>(readerPilotSchema);

export function configureReaderPilot(store: Store, environments: Environments, project: string, settings: unknown, expected: number): Revision<ReaderPilot> {
  if (!valid(settings)) throw new EngineError("reader_pilot_invalid", "The experiment requires explicit roles, limits and its L2 stop boundary", valid.errors);
  const env = environments.get(project).value;
  requireCondition(!settings.planning || settings.planning.maxRequestChars <= settings.maxRequestChars,
    "reader_pilot_invalid", "Planning cannot exceed the overall request ceiling");
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
  return store.write<ReaderPilot>({ id: `reader-pilot:${project}`, kind: "reader-pilot", expected, value: { ...settings, projectId: project } });
}

export function readerPilot(store: Store, project: string): Revision<ReaderPilot> | null {
  const record = store.get<ReaderPilot>(`reader-pilot:${project}`);
  if (!record) return null;
  requireCondition(record.kind === "reader-pilot" && record.value.projectId === project, "reader_pilot_invalid", "Foreign pilot configuration");
  const { projectId: _projectId, ...settings } = record.value;
  requireCondition(valid(settings), "reader_pilot_invalid", "Stored pilot configuration is invalid");
  return record.value.active ? record : null;
}

export function assertPilotBoundary(store: Store, project: string, phase: string): void {
  requireCondition(!readerPilot(store, project) || !["R2", "L3", "R3"].includes(phase),
    "pilot_boundary_reached", "The experiment stops after accepted L2, before R2; audit and an owner decision are required");
}

/** The source environment stays unchanged so accepted source/assessment history
 * retains its original references. New attempts record the pilot separately. */
export function pilotEnvironment(environment: Environment, pilot: ReaderPilot): Environment {
  return { ...environment, timeoutMs: pilot.callTimeoutMs ?? environment.timeoutMs,
    implementer: { ...environment.implementer, command: pilot.agentCommand },
    reviewer: { ...environment.reviewer, command: pilot.agentCommand } };
}

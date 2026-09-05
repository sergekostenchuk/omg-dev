import { Ajv } from "ajv";
import { EngineError } from "../errors.js";
import type { Json } from "../canonical.js";
import type { Ref, Stage } from "../pipeline/contracts.js";
import type { Selector } from "../evidence/evidence.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import type { Environment } from "../runtime/environment.js";

export type ProductCommand =
  | { type: "configure"; project: string; expected: number; environment: Omit<Environment, "projectId"> }
  | { type: "begin-research"; project: string; level: "R0" | "R1" | "R2" }
  | { type: "finish-research"; project: string; level: "R0" | "R1" | "R2"; draft: Ref; expected: number }
  | { type: "seal-layer"; project: string; level: 1 | 2 | 3; expected: number }
  | { type: "assess"; project: string; expected: number }
  | { type: "draft-om"; project: string; feasibility: Ref; expected: number }
  | { type: "create-project"; project: string; title: string }
  | { type: "prepare-stage"; project: string; stage: UpstreamStage }
  | { type: "source-document"; project: string; id: string; text: string; media: "text/plain" | "application/json"; expected: number }
  | { type: "answer-decision"; question: string; expected: number; value: Json }
  | { type: "answer-fact"; question: string; expected: number; source: Ref; selector: Selector }
  | { type: "reopen-question"; question: string; expected: number }
  | { type: "save-graph"; project: string; expected: number; graph: unknown }
  | { type: "refine-graph"; project: string; expected: number; draft: Ref }
  | { type: "draft-stage"; project: string; stage: UpstreamStage; draftId: string; expected: number }
  | { type: "accept-stage"; project: string; stage: Stage; expected: number }
  | { type: "project"; project: string }
  | { type: "export-stage"; project: string; stage: Stage };

const string = { type: "string", minLength: 1, maxLength: 4000 };
const project = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$" };
const expected = { type: "integer", minimum: 0 };
const ref = { type: "object", additionalProperties: false, required: ["id", "revision", "hash"],
  properties: { id: string, revision: { type: "integer", minimum: 1 }, hash: { type: "string", pattern: "^[a-f0-9]{64}$" } } };
const stage = { enum: ["discovery", "concept", "operation-map", "specification", "features", "om-g2", "compilation", "execution"] };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const command = (type: string, properties: Record<string, unknown>) => object({ type: { const: type }, ...properties });
const processCommand = object({ executable: string, args: { type: "array", items: { type: "string" } } });
const role = object({ actor: string, model: string, effort: { enum: ["low", "medium", "high", "xhigh", "max", "ultra"] }, command: processCommand });
const researchLevel = { enum: ["R0", "R1", "R2"] };
const schema = { oneOf: [
  command("configure", { project, expected, environment: object({ workspace: string, implementer: role, reviewer: role,
    fullCheck: processCommand, timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 } }) }),
  command("begin-research", { project, level: researchLevel }),
  command("finish-research", { project, level: researchLevel, draft: ref, expected }),
  command("seal-layer", { project, level: { enum: [1, 2, 3] }, expected }),
  command("assess", { project, expected }), command("draft-om", { project, feasibility: ref, expected }),
  command("create-project", { project, title: string }),
  command("prepare-stage", { project, stage: { enum: UPSTREAM_STAGES } }),
  command("source-document", { project, id: project, text: { type: "string", maxLength: 5_000_000 }, media: { enum: ["text/plain", "application/json"] }, expected }),
  command("answer-decision", { question: string, expected, value: {} }),
  command("answer-fact", { question: string, expected, source: ref, selector: { oneOf: [
    object({ kind: { const: "json-pointer" }, pointer: { type: "string" } }),
    object({ kind: { const: "text-range" }, start: expected, end: { type: "integer", minimum: 1 } }),
  ] } }),
  command("reopen-question", { question: string, expected }),
  command("save-graph", { project, expected, graph: { type: "object" } }),
  command("refine-graph", { project, expected, draft: ref }),
  command("draft-stage", { project, stage: { enum: UPSTREAM_STAGES }, draftId: string, expected }),
  command("accept-stage", { project, stage, expected }),
  command("project", { project }), command("export-stage", { project, stage }),
] };
const validate = new Ajv({ allErrors: true }).compile<ProductCommand>(schema);
export function parseCommand(value: unknown): ProductCommand {
  if (!validate(value)) throw new EngineError("command_invalid", "Missing, extra or invalid command fields", validate.errors);
  return value;
}

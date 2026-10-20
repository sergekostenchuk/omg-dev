import type { MapStatusDelta } from "../graph/map-status.js";
import { Ajv } from "ajv";
import { EngineError } from "../errors.js";
import type { Json } from "../canonical.js";
import type { Ref, Stage } from "../pipeline/contracts.js";
import type { Selector } from "../evidence/evidence.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import type { DetailSelector } from "../compiler/context.js";
import type { Environment } from "../runtime/environment.js";
import { readerPilotSchema, type ReaderPilotSettings } from "../discovery/reader-pilot.js";
import type { ContextRecoverySelector } from '../discovery/context-recovery.js';
import type { AdapterLineageDeclaration } from '../adapters/adapter-lineage.js';
import type { EarlyStageInstruction } from './early-stage-driver.js';

export type ProductCommand =
  | {type:'recover-research-response';project:string;call:Ref;session:Ref}
  | ({type:'declare-adapter-lineage';project:string} & AdapterLineageDeclaration)
  | {type:'observe-runtime';project:string;scope:Ref;obligation:string;key:string}
  | {type:'recover-runtime-observation';project:string;observation:Ref}
  | {type:'retry-planned-read';project:string;child:Ref}
  | {type:'recover-context-session';project:string;session:Ref;selector:ContextRecoverySelector}
  | {type:"recover-model-call";project:string;call:Ref}
  | {type:"permit-cancelled-call-retry";project:string;call:Ref}
  | {type:"recover-om-capacity";project:string;packet:Ref}
  | {type:"permit-limited-call-retry";project:string;call:Ref}
  | { type: "om-start"; project: string; outcomes?: string[] }
  | { type: "om-continue"; project: string; resumeStop?: string; release?: "regate_owner_policy" }
  | { type: "om-state"; project: string }
  | { type: "environment-readiness"; project: string }
  | { type: "om-spend"; project: string }
  | { type: "om-stop"; project: string }
  | { type: "om-fsck"; project: string }
  | { type: "om-decisions"; project: string }
  | { type: "om-regate"; project: string }
  | { type: "set-map-status"; project: string; expected: number; base: Ref; nodes: MapStatusDelta['nodes'] }
  | { type: "research-stage"; project: string; draftId: string; maxTurns: number }
  | { type: "early-stage-run"; project: string; maxTurns: number; maxCalls: number; draftId?: string; outcomes?: string[];
      instruction?: EarlyStageInstruction }
  | { type: "revise-early-stage-input"; project: string; expected: number; instruction: EarlyStageInstruction }
  | { type: "model-usage"; project: string; since: number }
  | { type: "configure-reader-pilot"; project: string; expected: number; settings: ReaderPilotSettings }
  | { type: "configure-saved-synthesis"; project: string; question: string; expected: number }
  | { type: "research-draft"; project: string; draftId: string; maxTurns: number }
  | { type: "execute-plan"; project: string; plan: Ref; retry: boolean; maxContextChars: number; maxCorrections: number }
  | { type: "stop-execution"; project: string }
  | { type: "recover-execution"; project: string }
  | { type: "configure"; project: string; expected: number; environment: Omit<Environment, "projectId"> }
  | { type: "configure-om-dispatch"; project: string; protocol: "codex-stdio" | "devin-stdio" }
  | { type: "assess"; project: string; expected: number }
  | { type: "draft-om"; project: string; feasibility: Ref; expected: number }
  | { type: "compile"; project: string }
  | { type: "task-context"; project: string; plan: Ref; task: string; maxChars: number }
  | { type: "task-detail"; project: string; plan: Ref; task: string; kind: "graph" | "evidence" | "evidence-index"; selector: DetailSelector; maxChars: number }
  | { type: "draft-plan"; project: string; plan: Ref; expected: number }
  | { type: "create-project"; project: string; title: string }
  | { type: "prepare-stage"; project: string; stage: UpstreamStage }
  | { type: "source-document"; project: string; id: string; text: string; media: "text/plain" | "application/json"; expected: number }
  | { type: "source-file"; project: string; id: string; path: string; media: "text/plain" | "application/json"; expected: number }
  | { type: "answer-decision"; question: string; expected: number; value: Json }
  | { type: "answer-decision"; mode: "discovery-condition"; project: string; draft: string; verdictRef: Ref; conditionId: string; optionId: string }
  | { type: "answer-fact"; question: string; expected: number; source: Ref; selector: Selector }
  | { type: "reopen-question"; question: string; expected: number }
  | { type: "save-graph"; project: string; expected: number; graph: unknown }
  | { type: "build-map"; project: string; draftId: string; expected: number }
  | { type: "draft-stage"; project: string; stage: UpstreamStage; draftId: string; expected: number }
  | { type: "accept-stage"; project: string; stage: Stage; expected: number }
  | { type: "project"; project: string }
  | { type: "stage-summary"; project: string; stage: Stage; draftId?: string }
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
role.properties['speed'] = { enum: ["inherited", "fast"] };
role.properties['commandContract'] = { enum: ["role-command/universal-v1", "role-command/modes-v1"] };
role.properties['modeCommands'] = { type: "object", additionalProperties: false, required: [], properties: {
  implement: processCommand, review: processCommand, chat: processCommand,
} };
const environmentSettings = object({ workspace: string, implementer: role, reviewer: role, fullCheck: processCommand,
  timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 } });
// Added after object() fixed the required set, so a configure without it stays valid; the saved-environment validator judges the value.
environmentSettings.properties['requestCapacityChars'] = { type: "integer", minimum: 1 };
// WB1 (№4552): optional like the capacity; without it the project keeps working without web research.
environmentSettings.properties['webResearch'] = object({ enabled: { type: "boolean" }, gatewayUrl: string,
  timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 }, budgetContract: { const: 'web-budget/v2' },
  limits: object({ materialChars: { const: 2000000 }, responseBytes: { type: "integer", minimum: 1, maximum: 64000000 } }) });
const recoverySelector=object({record:ref,pointer:{type:'string'}});
recoverySelector.properties['page']=object({offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}});
const text = { ...string, pattern: "\\S" };
// Optional after object() fixed the required set: an absent intent or stop is the driver's own case, never an empty value.
const omStart = command("om-start", { project });
omStart.properties['outcomes'] = { type: "array", minItems: 1, items: text };
const omContinue = command("om-continue", { project });
omContinue.properties['resumeStop'] = text;
// RL3 (№4218): the owner's explicit release of the wait on the policies their reopening asked — the pass then decides them by OWN1.
omContinue.properties['release'] = { const: "regate_owner_policy" };
const selector = { oneOf: [
  object({ kind: { const: "json-pointer" }, pointer: { type: "string" } }),
  object({ kind: { const: "text-range" }, start: expected, end: { type: "integer", minimum: 1 } }),
] };
const instruction = object({ title: string, id: project,
  text: { type: "string", minLength: 1, maxLength: 5_000_000 }, media: { enum: ["text/plain", "application/json"] },
  brief: selector });
instruction.properties['objective'] = selector;
const earlyStageRun = command("early-stage-run", { project,
  maxTurns: { type: "integer", minimum: 1, maximum: 100 }, maxCalls: { type: "integer", minimum: 1, maximum: 100 } });
earlyStageRun.properties['draftId'] = string;
earlyStageRun.properties['outcomes'] = { type: "array", minItems: 1, items: text };
earlyStageRun.properties['instruction'] = instruction;
const reviseEarlyStageInput = command("revise-early-stage-input", { project, expected, instruction });
const stageSummary = command("stage-summary", { project, stage });
stageSummary.properties['draftId'] = string;
const schema = { oneOf: [
  omStart, omContinue, command("om-state", { project }), command("environment-readiness", { project }), command("om-spend", { project }), command("om-stop", { project }), command("om-fsck", { project }),
  command("om-decisions", { project }),
  // RL3 (№4205): the owner's explicit reopening of a completed pass's accepted L3 by the AT1 door.
  command("om-regate", { project }),
  command('observe-runtime',{project,scope:ref,obligation:string,key:string}),
  command('recover-runtime-observation',{project,observation:ref}),
  command('retry-planned-read',{project,child:ref}),
  command('recover-context-session',{project,session:ref,selector:recoverySelector}),
  command('recover-research-response', { project, call: ref, session: ref }),
  command('declare-adapter-lineage', { project, path: string, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    basis: { type: 'array', minItems: 1, items: string } }),
  command("recover-model-call", {project,call:ref}),
  command("permit-cancelled-call-retry", {project,call:ref}),
  command("recover-om-capacity", {project,packet:ref}),
  command("permit-limited-call-retry", {project,call:ref}),
  command("set-map-status", { project, expected, base: ref, nodes: { type: "array", minItems: 1, items: object({
    id: string, status: { enum: ["existing", "future"] }, explanation: string,
    code: { type: "array", items: object({ path: string, access: { enum: ["read", "write"] }, status: { const: "existing" } }) },
  }) } }),
  command("research-stage", { project, draftId: string, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  earlyStageRun, reviseEarlyStageInput,
  command("model-usage", { project, since: expected }),
  command("configure-reader-pilot", { project, expected, settings: readerPilotSchema }),
  command("configure-saved-synthesis", { project, question: string, expected }),
  command("research-draft", { project, draftId: string, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  command("execute-plan", { project, plan: ref, retry: { type: "boolean" }, maxContextChars: { type: "integer", minimum: 1 }, maxCorrections: expected }), command("stop-execution", { project }),
  command("recover-execution", { project }),
  command("configure", { project, expected, environment: environmentSettings }),
  command("configure-om-dispatch", { project, protocol: { enum: ["codex-stdio", "devin-stdio"] } }),
  command("assess", { project, expected }), command("draft-om", { project, feasibility: ref, expected }),
  command("compile", { project }), command("draft-plan", { project, plan: ref, expected }),
  command("task-context", { project, plan: ref, task: string, maxChars: { type: "integer", minimum: 1 } }),
  command("task-detail", { project, plan: ref, task: string, kind: { enum: ["graph", "evidence", "evidence-index"] },
    selector: object({ id: { type: "string" }, pointer: { type: "string" }, start: { anyOf: [expected, { type: "null" }] }, end: { anyOf: [expected, { type: "null" }] } }),
    maxChars: { type: "integer", minimum: 1 } }),
  command("create-project", { project, title: string }),
  command("prepare-stage", { project, stage: { enum: UPSTREAM_STAGES } }),
  command("source-document", { project, id: project, text: { type: "string", maxLength: 5_000_000 }, media: { enum: ["text/plain", "application/json"] }, expected }),
  command("source-file", { project, id: project, path: string, media: { enum: ["text/plain", "application/json"] }, expected }),
  command("answer-decision", { question: string, expected, value: {} }),
  command("answer-decision", { mode: { const: "discovery-condition" }, project, draft: string, verdictRef: ref, conditionId: string, optionId: string }),
  command("answer-fact", { question: string, expected, source: ref, selector }),
  command("reopen-question", { question: string, expected }),
  command("save-graph", { project, expected, graph: { type: "object" } }),
  command("build-map", { project, draftId: string, expected }),
  command("draft-stage", { project, stage: { enum: UPSTREAM_STAGES }, draftId: string, expected }),
  command("accept-stage", { project, stage, expected }),
  command("project", { project }), stageSummary, command("export-stage", { project, stage }),
] };
const validate = new Ajv({ allErrors: true }).compile<ProductCommand>(schema);
export function parseCommand(value: unknown): ProductCommand {
  if (!validate(value)) throw new EngineError("command_invalid", "Missing, extra or invalid command fields", validate.errors);
  return value;
}

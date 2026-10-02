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
import { obligationPolicySchema, type ObligationPolicy } from '../graph/obligation-policy.js';
import type { AdapterLineageDeclaration } from '../adapters/adapter-lineage.js';

export type ProductCommand =
  | {type:"recover-legacy-operation";project:string;operation:Ref;token:string}
  | {type:'recover-research-response';project:string;call:Ref;session:Ref}
  | ({type:'declare-adapter-lineage';project:string} & AdapterLineageDeclaration)
  | {type:'observe-runtime';project:string;scope:Ref;obligation:string;key:string}
  | {type:'recover-runtime-observation';project:string;observation:Ref}
  | {type:'apply-obligation-policy';project:string;scope:Ref;policy:ObligationPolicy}
  | {type:'retry-planned-read';project:string;child:Ref}
  | {type:'recover-context-session';project:string;session:Ref;selector:ContextRecoverySelector}
  | {type:'allocate-research-trial';project:string;key:string;previousPolicy:Ref;limit:number;blockLimit:number}
  | {type:"recover-model-call";project:string;call:Ref}
  | {type:"continue-preparation";project:string;maxCalls:number}
  | { type: "om-start"; project: string; outcomes?: string[] }
  | { type: "om-continue"; project: string; resumeStop?: string }
  | { type: "om-state"; project: string }
  | { type: "om-spend"; project: string }
  | { type: "om-stop"; project: string }
  | { type: "set-map-status"; project: string; expected: number; base: Ref; nodes: MapStatusDelta['nodes'] }
  | { type: "research-stage"; project: string; draftId: string; maxTurns: number }
  | { type: "research-phase"; project: string; phase: "R1" | "R2" | "L2" | "L3"; draftId: string; maxTurns: number }
  | { type: "model-usage"; project: string; since: number }
  | { type: "configure-reader-pilot"; project: string; expected: number; settings: ReaderPilotSettings }
  | { type: "configure-saved-synthesis"; project: string; question: string; expected: number }
  | { type: "research-draft"; project: string; draftId: string; maxTurns: number }
  | { type: "execute-plan"; project: string; plan: Ref; retry: boolean; maxContextChars: number; maxCorrections: number }
  | { type: "stop-execution"; project: string }
  | { type: "recover-execution"; project: string }
  | { type: "repair-plan"; project: string; run: Ref; maxTurns: number }
  | { type: "configure"; project: string; expected: number; environment: Omit<Environment, "projectId"> }
  | { type: "configure-om-dispatch"; project: string; protocol: "codex-stdio" | "devin-stdio" }
  | { type: "begin-research"; project: string; level: "R0" | "R1" | "R2" }
  | { type: "finish-research"; project: string; level: "R0" | "R1" | "R2"; draft: Ref; expected: number }
  | { type: "seal-layer"; project: string; level: 1 | 2 | 3; expected: number }
  | { type: "prepare-layer"; project: string; level: 2 | 3 }
  | { type: "build-layer"; project: string; level: 2 | 3; draft: Ref; expected: number }
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
  | { type: "answer-fact"; question: string; expected: number; source: Ref; selector: Selector }
  | { type: "reopen-question"; question: string; expected: number }
  | { type: "save-graph"; project: string; expected: number; graph: unknown }
  | { type: "build-map"; project: string; draftId: string; expected: number }
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
role.properties['speed'] = { enum: ["inherited", "fast"] };
const environmentSettings = object({ workspace: string, implementer: role, reviewer: role, fullCheck: processCommand,
  timeoutMs: { type: "integer", minimum: 100, maximum: 3600000 } });
// Added after object() fixed the required set, so a configure without it stays valid; the saved-environment validator judges the value.
environmentSettings.properties['requestCapacityChars'] = { type: "integer", minimum: 1 };
const researchLevel = { enum: ["R0", "R1", "R2"] };
const recoverySelector=object({record:ref,pointer:{type:'string'}});
recoverySelector.properties['page']=object({offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}});
const text = { ...string, pattern: "\\S" };
// Optional after object() fixed the required set: an absent intent or stop is the driver's own case, never an empty value.
const omStart = command("om-start", { project });
omStart.properties['outcomes'] = { type: "array", minItems: 1, items: text };
const omContinue = command("om-continue", { project });
omContinue.properties['resumeStop'] = text;
const schema = { oneOf: [
  omStart, omContinue, command("om-state", { project }), command("om-spend", { project }), command("om-stop", { project }),
  command("recover-legacy-operation",{project,operation:ref,token:string}),
  command('observe-runtime',{project,scope:ref,obligation:string,key:string}),
  command('recover-runtime-observation',{project,observation:ref}),
  command('apply-obligation-policy',{project,scope:ref,policy:obligationPolicySchema}),
  command('retry-planned-read',{project,child:ref}),
  command('recover-context-session',{project,session:ref,selector:recoverySelector}),
  command('recover-research-response', { project, call: ref, session: ref }),
  command('declare-adapter-lineage', { project, path: string, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    basis: { type: 'array', minItems: 1, items: string } }),
  command('allocate-research-trial',{project,key:string,previousPolicy:ref,limit:{type:'integer',minimum:1},blockLimit:{type:'integer',minimum:1}}),
  command("recover-model-call", {project,call:ref}),
  command("continue-preparation", {project,maxCalls:{type:"integer",minimum:1,maximum:100}}),
  command("set-map-status", { project, expected, base: ref, nodes: { type: "array", minItems: 1, items: object({
    id: string, status: { enum: ["existing", "future"] }, explanation: string,
    code: { type: "array", items: object({ path: string, access: { enum: ["read", "write"] }, status: { const: "existing" } }) },
  }) } }),
  command("research-stage", { project, draftId: string, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  command("research-phase", { project, phase: { enum: ["R1", "R2", "L2", "L3"] }, draftId: string, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  command("model-usage", { project, since: expected }),
  command("configure-reader-pilot", { project, expected, settings: readerPilotSchema }),
  command("configure-saved-synthesis", { project, question: string, expected }),
  command("research-draft", { project, draftId: string, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  command("execute-plan", { project, plan: ref, retry: { type: "boolean" }, maxContextChars: { type: "integer", minimum: 1 }, maxCorrections: expected }), command("stop-execution", { project }),
  command("recover-execution", { project }),
  command("repair-plan", { project, run: ref, maxTurns: { type: "integer", minimum: 1, maximum: 100 } }),
  command("configure", { project, expected, environment: environmentSettings }),
  command("configure-om-dispatch", { project, protocol: { enum: ["codex-stdio", "devin-stdio"] } }),
  command("begin-research", { project, level: researchLevel }),
  command("finish-research", { project, level: researchLevel, draft: ref, expected }),
  command("seal-layer", { project, level: { enum: [1, 2, 3] }, expected }),
  command("prepare-layer", { project, level: { enum: [2, 3] } }),
  command("build-layer", { project, level: { enum: [2, 3] }, draft: ref, expected }),
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
  command("answer-fact", { question: string, expected, source: ref, selector: { oneOf: [
    object({ kind: { const: "json-pointer" }, pointer: { type: "string" } }),
    object({ kind: { const: "text-range" }, start: expected, end: { type: "integer", minimum: 1 } }),
  ] } }),
  command("reopen-question", { question: string, expected }),
  command("save-graph", { project, expected, graph: { type: "object" } }),
  command("build-map", { project, draftId: string, expected }),
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

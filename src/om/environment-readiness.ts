import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { stdioProviderByModule } from "../adapters/stdio-providers.js";
import type { Json } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import type { Command } from "../graph/model.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { commandModulePath, executablePath, readEnvironmentAt, repositoryHead, resolveRoleMode, uniqueTransactionGuards,
  type Environment, type EnvironmentRole, type RoleMode } from "../runtime/environment.js";
import { Store, type Revision, type TransactionGuard } from "../storage/store.js";
import { readCapacity } from "./capacity.js";
import { readDispatch } from "./dispatch.js";
import { delivered, isPlainObject, isText, refused, type OmResult, type Sealed } from "./refusal.js";

/**
 * ENV1 (contract №4864 §4) — the conditions of the environment, each with the moment it is required by.
 *
 * One read-only reader: what is observed available now, what is missing or misconfigured, what is a future condition of
 * the product being made, and what no static reading can prove (authorization, a model, a check's result). The basis is
 * the exact Store records and local observations of this moment — never a lasting proof and never a saved admission.
 * A new OM pass is admitted only on its own conditions (omStartReadiness); documentary Discovery needs only its runner.
 */
const UNIT = "ENV1";
export const READINESS_CONTRACT = "environment-readiness/v1" as const;
export type ReadinessState = "available" | "missing" | "invalid" | "future" | "unverified";
export type ReadinessMoment = "research" | "om-start" | "implement" | "review" | "check" | "web-research";
export interface ReadinessCondition {
  condition: string; state: ReadinessState; requiredBy: ReadinessMoment; at: string;
  basis: { refs: Ref[]; observed: Json | null }; action: string; code?: string;
}
export interface EnvironmentReadiness { contract: typeof READINESS_CONTRACT; project: string; conditions: ReadinessCondition[] }
/** The conditions a new OM pass stands on, with the guards its creating transaction carries. */
export interface OmStartReadiness extends EnvironmentReadiness { guards: TransactionGuard[] }

/** The conditions a NEW OM pass requires (contract table): its research runners, the exact Git root and HEAD, capacity, dispatch. */
const OM_START = Object.freeze(["environment", "research:implementer", "research:reviewer", "repository", "capacity", "dispatch"]);

const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
function requireRequest(store: unknown, request: unknown): asserts request is { project: string } {
  requireCondition(store instanceof Store && object(request) && isText(request.project) && Object.keys(request).length === 1,
    "readiness_request_invalid", "The environment conditions are read by their project");
}
const condition = (value: Omit<ReadinessCondition, "basis"> & { refs?: Ref[]; observed?: Json | null }): ReadinessCondition => {
  const { refs, observed, ...rest } = value;
  return { ...rest, basis: { refs: refs ?? [], observed: observed ?? null } };
};
const codeOf = (error: unknown): string => error instanceof EngineError ? error.code : "readiness_observation_failed";
const messageOf = (error: unknown): string => error instanceof Error ? error.message : "The condition could not be observed";

/** A role command of one mode: its resolvable executable and, for a `node <file>` form, the script it names. */
function runner(project: string, environment: Revision<Environment>, role: EnvironmentRole, mode: RoleMode,
  requiredBy: ReadinessMoment): ReadinessCondition {
  const at = `environment:${project}/${role}/${mode}`, refs = [reference(environment)];
  let command: Command;
  try { command = resolveRoleMode(role, environment.value[role], mode).command; }
  catch (error) {
    return condition({ condition: `${mode}:${role}`, state: "missing", requiredBy, at, refs, code: codeOf(error),
      action: `configure a ${mode} command for the ${role} role` });
  }
  const workspace = environment.value.workspace;
  try {
    const executable = executablePath(command, workspace), module = commandModulePath(command, workspace);
    const moduleStat = module ? statSync(module, { throwIfNoEntry: false }) : null;
    if (module && !moduleStat) return condition({ condition: `${mode}:${role}`, state: "missing", requiredBy, at, refs,
      code: "adapter_module_missing", observed: { executable, module }, action: `install the adapter script or configure another ${mode} command` });
    if (moduleStat && !moduleStat.isFile()) return condition({ condition: `${mode}:${role}`, state: "invalid", requiredBy, at, refs,
      code: "adapter_module_invalid", observed: { executable, module }, action: `configure a regular adapter module file for the ${role} ${mode} command` });
    const provider = module ? stdioProviderByModule(basename(module)) : null;
    // Local resolvability only: neither the provider's authorization nor its model is proved by a path.
    return condition({ condition: `${mode}:${role}`, state: "available", requiredBy, at, refs,
      observed: { executable, module, adapter: provider?.protocol ?? null }, action: "none; the first call proves authorization and model" });
  } catch (error) {
    return condition({ condition: `${mode}:${role}`, state: "missing", requiredBy, at, refs, code: codeOf(error),
      action: `make the ${role} ${mode} executable available or configure another command` });
  }
}

interface Observed { conditions: ReadinessCondition[]; guards: TransactionGuard[] }
function observe(store: Store, project: string): Observed {
  const id = `environment:${project}`, head = store.get<Environment>(id);
  if (!head) return { conditions: [condition({ condition: "environment", state: "missing", requiredBy: "research", at: id,
    code: "environment_missing", action: "configure the project environment" })], guards: [{ id, absent: true }] };
  let environment: Revision<Environment>;
  try { environment = readEnvironmentAt(store, project, reference(head)); }
  catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return { conditions: [condition({ condition: "environment", state: "invalid", requiredBy: "research", at: id, refs: [reference(head)],
      code: error.code, action: "configure the project environment again" })], guards: [reference(head)] };
  }
  const envRef = reference(environment), guards: TransactionGuard[] = [envRef];
  const conditions: ReadinessCondition[] = [condition({ condition: "environment", state: "available", requiredBy: "research", at: id,
    refs: [envRef], observed: { workspace: environment.value.workspace }, action: "none" })];
  conditions.push(runner(project, environment, "implementer", "research", "research"), runner(project, environment, "reviewer", "research", "research"));
  try {
    const repository = repositoryHead(environment.value.workspace);
    conditions.push(condition({ condition: "repository", state: "available", requiredBy: "om-start", at: environment.value.workspace,
      observed: { root: repository.root, head: repository.head, tree: repository.tree, dirty: repository.dirty },
      action: repository.dirty ? "none; uncommitted changes are shown, not refused" : "none" }));
  } catch (error) {
    conditions.push(condition({ condition: "repository", state: codeOf(error) === "repository_root" ? "invalid" : "missing", requiredBy: "om-start",
      at: environment.value.workspace, code: codeOf(error), observed: { message: messageOf(error) },
      action: codeOf(error) === "repository_root" ? "select the repository root as the workspace (configure), then start again"
        : codeOf(error) === "repository_head_missing" ? "commit the initial state of the workspace, then start again"
        : "make the workspace a Git repository, then start again" }));
  }
  const capacity = readCapacity(store, { project, environment: envRef, current: true });
  if (capacity.ok) {
    guards.push(...capacity.value.guards);
    conditions.push(condition({ condition: "capacity", state: "available", requiredBy: "om-start", at: id, refs: [...capacity.value.references],
      observed: { maxRequestChars: capacity.value.maxRequestChars }, action: "none" }));
  } else conditions.push(condition({ condition: "capacity", state: capacity.refusal.code === "capacity_missing" ? "missing" : "invalid",
    requiredBy: "om-start", at: capacity.refusal.at.target, refs: [envRef], code: capacity.refusal.code, action: "configure requestCapacityChars" }));
  const dispatch = readDispatch(store, { project });
  if (dispatch.ok) {
    const adapter = dispatch.value.dispatch.adapter;
    guards.push(...dispatch.value.guards);
    conditions.push(condition({ condition: "dispatch", state: "available", requiredBy: "om-start", at: adapter.id, refs: [...dispatch.value.references],
      observed: { protocol: store.get<{ protocol?: Json }>(adapter.id, adapter.revision)?.value.protocol ?? null }, action: "none" }));
  } else conditions.push(condition({ condition: "dispatch", state: dispatch.refusal.code === "record_missing" ? "missing" : "invalid",
    requiredBy: "om-start", at: dispatch.refusal.at.target, code: dispatch.refusal.code, action: "configure-om-dispatch" }));
  conditions.push(runner(project, environment, "implementer", "implement", "implement"), runner(project, environment, "reviewer", "review", "review"));
  conditions.push(checkCondition(project, environment));
  const web = environment.value.webResearch;
  conditions.push(condition({ condition: "web-research", state: web?.enabled ? "unverified" : "missing", requiredBy: "web-research",
    at: `${id}/webResearch`, refs: [envRef], observed: web ? { enabled: web.enabled, gatewayUrl: web.gatewayUrl } : null,
    action: web?.enabled ? "none; the gateway's availability is not probed here" : "configure webResearch to let research search the web" }));
  return { conditions, guards: uniqueTransactionGuards(guards) };
}
/** The full check: never run here and never reported ready. A script the product itself will create is a future condition. */
function checkCondition(project: string, environment: Revision<Environment>): ReadinessCondition {
  const command = environment.value.fullCheck, workspace = environment.value.workspace, at = `environment:${project}/fullCheck`;
  try {
    executablePath(command, workspace);
    const module = commandModulePath(command, workspace);
    return module && !existsSync(module)
      ? condition({ condition: "check", state: "future", requiredBy: "check", at, observed: { module }, action: "the product's work creates the check script" })
      : condition({ condition: "check", state: "unverified", requiredBy: "check", at, action: "none; its result is the task check's own" });
  } catch {
    return condition({ condition: "check", state: "future", requiredBy: "check", at, action: "the check command becomes available with the product's work" });
  }
}

/** The read-only status of a project's environment conditions. It writes nothing and admits nothing. */
export function readEnvironmentReadiness(store: Store, request: { project: string }): EnvironmentReadiness {
  requireRequest(store, request);
  return { contract: READINESS_CONTRACT, project: request.project, conditions: observe(store, request.project).conditions };
}
/**
 * The admission of a NEW OM pass (startPass, both the cold and the saved-input branch): every OM-start condition is
 * observed available now, or an addressed refusal before any B1, pass record or model call. The guards go into the very
 * transaction that creates the pass, so a change made by another Store after this reading refuses that write.
 */
export function omStartReadiness(store: Store, project: string): OmResult<Sealed<OmStartReadiness>> {
  requireRequest(store, { project });
  const observed = observe(store, project);
  const unmet = OM_START.flatMap(name => {
    const found = observed.conditions.find(item => item.condition === name);
    return found && found.state === "available" ? [] : [found ?? condition({ condition: name, state: "missing", requiredBy: "om-start",
      at: `environment:${project}`, code: "environment_missing", action: "configure the project environment" })];
  });
  if (unmet.length) {
    const first = unmet[0]!;
    return refused("environment_not_ready", `A new OM pass needs: ${unmet.map(item => `${item.condition} (${item.state}${item.code ? `, ${item.code}` : ""}) — ${item.action}`).join("; ")}`,
      { unit: UNIT, target: first.at, field: first.condition }, "readiness");
  }
  return delivered({ contract: READINESS_CONTRACT, project, conditions: observed.conditions, guards: observed.guards }) as OmResult<Sealed<OmStartReadiness>>;
}

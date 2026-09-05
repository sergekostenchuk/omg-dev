import { canonical, digest } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import { RefinementRelations } from "../graph/relations.js";
import type { Command } from "../graph/model.js";
import type { MachinePlan } from "./model.js";

export interface ContextText { text: string; chars: number; utf8Bytes: number; hash: string }
export function boundedContext(value: unknown, maxChars: number): ContextText {
  requireCondition(Number.isSafeInteger(maxChars) && maxChars > 0, "context_budget_invalid", "Context needs a positive configured character allowance");
  const text = canonical(value);
  if (text.length > maxChars) throw new EngineError("context_budget_exceeded", "The essential context exceeds the allowance; increase it or refine the task instead of truncating its obligations",
    { requiredChars: text.length, maxChars });
  return { text, chars: text.length, utf8Bytes: Buffer.byteLength(text, "utf8"), hash: digest(text) };
}

/** This is an implementation brief, not the scheduler's complete machine plan. */
export function taskContext(plan: Revision<MachinePlan>, fullCheck: Command, taskId: string, maxChars: number): ContextText {
  requireCondition(fullCheck && typeof fullCheck.executable === "string" && fullCheck.executable.trim()
    && Array.isArray(fullCheck.args) && fullCheck.args.every(arg => typeof arg === "string"),
  "context_check_missing", "The implementation context needs its configured full-run command");
  const graph = plan.value.graphSnapshot;
  const task = plan.value.tasks.find(item => item.id === taskId);
  requireCondition(task, "task_foreign", "Task does not belong to the bound machine plan");
  const node = graph.nodes.find(item => item.id === task.node)!;
  const ancestry = new Set(new RefinementRelations(graph).ancestry(node.id).map(item => item.id));
  const testConnectors = new Set(task.tests.flatMap(test => test.covers));
  const connectors = graph.connectors.filter(connector => testConnectors.has(connector.id)
    || connector.bindings.some(binding => binding.level === 3 && [binding.producer, ...binding.consumers].some(endpoint => endpoint.node === node.id)))
    .map(connector => ({ ...connector, bindings: connector.bindings.filter(binding => binding.level === 3) }));
  const artifactIds = new Set([...task.produces, ...task.inputs.map(input => input.artifact), ...connectors.map(connector => connector.artifact)]);
  const controls = (graph.edges ?? []).filter(edge => ancestry.has(edge.source));
  const anchors = graph.anchors.filter(anchor => connectors.some(connector => connector.bindings.some(binding => binding.anchor === anchor.id)));
  const wakeTests = new Set([...connectors.flatMap(connector => connector.wakeTest ? [connector.wakeTest] : []), ...anchors.map(anchor => anchor.test)]);
  const tests = [...task.tests, ...graph.tests.filter(test => wakeTests.has(test.id) && !node.tests.includes(test.id))];
  const joins = graph.joins.filter(join => join.consumer === node.id);
  const routes = new Set([...connectors.map(connector => connector.returnsTo), ...controls.map(edge => edge.target), ...joins.flatMap(join => join.failures ? [join.failures.returnsTo] : [])]);
  for (const route of graph.nodes.filter(node => routes.has(node.id))) artifactIds.add(route.outcome);
  const artifacts = graph.artifacts.filter(artifact => artifactIds.has(artifact.id));
  const contractIds = new Set([...artifacts.map(artifact => artifact.contract), ...node.ports.map(port => port.contract)]);
  return boundedContext({ version: "omg-task-context/v1", binding: { plan: reference(plan), graph: plan.value.graph, task: task.id,
    base: { commit: plan.value.base.head, tree: plan.value.base.tree } },
    action: { title: task.title, outcome: task.outcome, ...(task.purpose ? { purpose: task.purpose, benefit: task.benefit!, beneficiary: task.beneficiary! } : {}) },
    scope: { boundary: task.boundary, code: node.code, ports: node.ports, packets: task.packets ?? [], ownership: task.ownership ?? [] },
    requirements: task.requirements ?? [], actor: graph.actors?.find(actor => actor.id === task.beneficiary) ?? null,
    inputs: task.inputs, produces: task.produces, artifacts,
    contracts: graph.contracts.filter(contract => contractIds.has(contract.id)),
    criteria: { tests, fullCheck, obligations: task.obligations, joins },
    connections: connectors, controls, anchors,
    transfers: (graph.transfers ?? []).filter(transfer => transfer.from === node.id || transfer.to === node.id),
    correction: graph.nodes.filter(node => routes.has(node.id)).map(node => ({ id: node.id, title: node.title, outcome: node.outcome, boundary: node.boundary })),
    details: { command: "task-detail", project: plan.value.projectId, plan: reference(plan), task: task.id,
      selectors: ["graph entity ID", "evidence-index", "bound evidence reference ID and JSON pointer or text range"] },
  }, maxChars);
}

export interface DetailSelector { id: string; pointer: string; start: number | null; end: number | null }
export function selectDetail(value: unknown, selector: DetailSelector): unknown {
  requireCondition(typeof selector.pointer === "string" && (selector.pointer === "" || selector.pointer.startsWith("/")),
    "context_selector_invalid", "Use an empty pointer or an explicit JSON pointer");
  let selected: unknown = value;
  for (const segment of selector.pointer === "" ? [] : selector.pointer.slice(1).split("/")) {
    requireCondition(!/~(?:[^01]|$)/.test(segment), "context_selector_invalid", "Invalid JSON pointer escape");
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    requireCondition(selected !== null && typeof selected === "object" && Object.hasOwn(selected, key)
      && (!Array.isArray(selected) || /^(0|[1-9][0-9]*)$/.test(key)), "context_detail_missing", "The exact selected field is missing");
    selected = (selected as Record<string, unknown>)[key];
  }
  if (selector.start !== null || selector.end !== null) {
    requireCondition(typeof selected === "string" && Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
      && selector.start! >= 0 && selector.end! > selector.start! && selector.end! <= selected.length,
    "context_selector_invalid", "A text range needs explicit valid offsets within a string");
    return selected.slice(selector.start!, selector.end!);
  }
  return selected;
}

export interface EvidenceDetail { ref: Ref; kind: string }

import type { Graph, Node, Boundary, Obligation } from "../graph/model.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Feasibility } from "../graph/refinement.js";
import { hashJson } from "../canonical.js";
import type { Requirement, WorkPacket } from "../graph/semantics-model.js";
import { nodeContext } from "../graph/node-context.js";
import { EngineError } from "../errors.js";
import type { Revision } from "../storage/store.js";

export interface ArtifactReceipt {
  projectId: string; artifact: string; node: string; signature: string; contractHash: string;
  commit: string; tree: string; value: { files: { path: string; hash: string | null }[] };
  plan?: Ref; run?: Ref;
}
export interface TaskInput { connector: string; artifact: string; producerTask: string | null; receipt: Ref | null; source: Ref | null }
export interface WriteGrant { path: string; from: string | null; transfer: string | null; producerTask: string | null; receipt: Ref | null }
export interface CompiledTask {
  researchObligations?: import('../graph/task-obligation-model.js').BoundTaskObligation[];
  id: string; node: string; title: string; outcome: string; signature: string;
  boundary: Boundary; writePaths: string[]; readPaths: string[]; tests: Graph['tests'];
  dependencies: string[]; inputs: TaskInput[]; produces: string[];
  obligations: { name: Obligation; status: "required" | "not_applicable"; reason: string }[];
  purpose?: string; benefit?: string; beneficiary?: string; requirements?: Requirement[]; packets?: WorkPacket[];
  ownership?: WriteGrant[];
}
export const TASK_CONTEXT_CONTRACT = 'omg-task-context/v2' as const;
export interface MachinePlan {
  taskContextContract?: typeof TASK_CONTEXT_CONTRACT;
  derivation?: 'external-inputs/v1';
  version: 1 | 2; projectId: string; graph: Ref; environment: Ref; stage: Ref; feasibility: Ref;
  base: NonNullable<Feasibility['repository']>; guards: Ref[]; tasks: CompiledTask[];
  graphSnapshot: Graph; hash: string;
}
export const EXTERNAL_INPUT_DERIVATION = 'external-inputs/v1' as const;
/** The namespace selects the formula even when the producer marker is lost. */
export function planDerivation(id: string): 'legacy' | typeof EXTERNAL_INPUT_DERIVATION {
  return typeof id === 'string' && /^plan:[^:]+:external-inputs-v1:/.test(id)
    ? EXTERNAL_INPUT_DERIVATION : 'legacy';
}
/** Only the new era has this envelope contract. This reader never follows plan dependencies. */
export function checkedPlanDerivation(plan: Revision<MachinePlan>, project?: string): ReturnType<typeof planDerivation> {
  const invalid = (field: string): never => { throw new EngineError('plan_derivation_invalid',
    'The external-input plan requires its exact producer, project and content-addressed body',
    { unit: 'compiler/model', target: typeof plan?.id === 'string' ? plan.id : 'plan', field }); };
  if (!plan || typeof plan.id !== 'string') invalid('plan');
  const derivation = planDerivation(plan.id);
  if (derivation === 'legacy') return derivation;
  const value = plan.value;
  if (plan.kind !== 'plan' || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !value || typeof value !== 'object' || Array.isArray(value)) invalid('plan');
  if (value.derivation !== EXTERNAL_INPUT_DERIVATION) invalid('derivation');
  if (value.version !== 2) invalid('version');
  if (Object.hasOwn(value, 'taskContextContract') && value.taskContextContract !== TASK_CONTEXT_CONTRACT) invalid('taskContextContract');
  if (typeof value.projectId !== 'string' || !value.projectId.length
    || (project !== undefined && project !== value.projectId)) invalid('projectId');
  const { hash, ...body } = value;
  if (hashJson(body) !== hash || hashJson(value) !== plan.hash) invalid('hash');
  if (plan.id !== `plan:${value.projectId}:external-inputs-v1:${hash}`) invalid('id');
  return derivation;
}
export const receiptId = (project: string, artifact: string): string => `artifact:${hashJson([project, artifact])}`;
export function nodeSignature(graph: Graph, node: Node): string {
  return hashJson({ graphId: graph.id, node, tests: graph.tests.filter(test => node.tests.includes(test.id)),
    ...(graph.researchObligations?.some(binding => binding.consumers.some(consumer => consumer.node === node.id))
      ? { researchObligations: graph.researchObligations.filter(binding => binding.consumers.some(consumer => consumer.node === node.id))
        .map(binding => ({ ...binding, consumers: binding.consumers.filter(consumer => consumer.node === node.id) })) } : {}),
    inputs: graph.connectors.filter(connector => connector.bindings.some(binding => binding.level === 3 && binding.consumers.some(consumer => consumer.node === node.id))),
    outcome: graph.contracts.find(contract => contract.id === graph.artifacts.find(artifact => artifact.id === node.outcome)?.contract),
    ...(graph.version === 2 ? { context: nodeContext(graph, node) } : {}) });
}

import { Ajv } from "ajv";
import { Store, type Revision } from "../storage/store.js";
import type { Graph } from "../graph/model.js";
import { graphSchema, graphV2Schema } from "../graph/schema.js";
import { git, type RepositoryState } from "../runtime/environment.js";
import { treeFile } from "../runtime/git-files.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { reference, isRef, type Ref } from "../pipeline/contracts.js";
import { EngineError, requireCondition } from "../errors.js";
import { hashJson, digest } from "../canonical.js";
import { receiptId, nodeSignature, type ArtifactReceipt, type TaskInput, type MachinePlan } from "./model.js";

const graphShapes = new Ajv({ strict: true, allowUnionTypes: true });
const receiptGraphShapes = [graphShapes.compile<Graph>(graphSchema), graphShapes.compile<Graph>(graphV2Schema)];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Compatibility with a graph only; the caller reads the exact record and establishes its execution proof. */
export function requireCompatibleReceipt(receipt: Revision<ArtifactReceipt> | null, project: string, graph: Graph,
  producerId: string, artifactId: string): Revision<ArtifactReceipt> {
  const invalid = (field: string): never => { throw new EngineError("receipt_compatibility_invalid",
    "Receipt compatibility needs well-formed arguments and resolvable graph addresses",
    { unit: "compiler/inputs", target: text(artifactId) ? artifactId : "artifact-receipt", field }); };
  if (!text(project)) invalid("project");
  if (!text(producerId)) invalid("producerId");
  if (!text(artifactId)) invalid("artifactId");
  if (!object(graph) || !receiptGraphShapes[graph.version === 2 ? 1 : 0]!(graph)) invalid("graph");
  if (receipt !== null && (!object(receipt) || !isRef(receipt) || !text(receipt.kind) || !object(receipt.value))) invalid("receipt");
  const artifact = graph.artifacts.find(artifact => artifact.id === artifactId);
  if (!artifact) return invalid("artifactId");
  const contract = graph.contracts.find(contract => contract.id === artifact.contract);
  if (!contract) return invalid(`graph.artifacts.${artifact.id}.contract`);
  const producer = graph.nodes.find(item => item.id === producerId);
  if (!producer) return invalid("producerId");
  if (!graph.artifacts.some(item => item.id === producer.outcome)) invalid(`graph.nodes.${producer.id}.outcome`);
  // nodeContext also reads contracts of the producer's other outputs; shape validation cannot prove these references.
  const contracts = new Set(graph.contracts.map(item => item.id));
  for (const output of graph.artifacts) if (!contracts.has(output.contract))
    invalid(`graph.artifacts.${output.id}.contract`);
  requireCondition(receipt && receipt.kind === "artifact" && receipt.value.projectId === project && receipt.value.artifact === artifact.id && receipt.value.node === producer.id
    && receipt.value.signature === nodeSignature(graph, producer) && receipt.value.contractHash === hashJson(contract.schema),
  "producer_not_ready", "A producer outside this horizon needs a compatible committed artifact");
  return receipt;
}

export function resolveArtifact(store: Store, project: string, graph: Graph, repository: RepositoryState,
  producerId: string, artifactId: string, sealed?: Ref[]): Pick<TaskInput, "receipt" | "source"> {
          const read = <T>(id: string): Revision<T> | null => {
            if (!sealed) return store.get<T>(id);
            const ref = sealed.find(item => item.id === id);
            requireCondition(ref, "plan_input_invalid", "External input is missing from the sealed basis");
            const record = store.get<T>(ref.id, ref.revision);
            requireCondition(record?.hash === ref.hash, "plan_input_invalid", "External input must match its canonical version");
            return record;
          };
          const artifact = graph.artifacts.find(artifact => artifact.id === artifactId)!;
          const contract = graph.contracts.find(contract => contract.id === artifact.contract)!;
          if (artifact.external) {
            const source = read<Source>(`source:${project}:${artifact.id}`);
            requireCondition(source && source.kind === "source" && source.value.projectId === project
              && (sealed ? digest(source.value.content) === source.value.sha256 : sourceIsCurrent(source.value)), "external_input_missing", "External artifact needs a verified source with the same ID");
            const value = source.value.mediaType === "application/json" ? JSON.parse(source.value.content) : source.value.content;
            requireCondition(new Ajv({ strict: true }).compile(contract.schema as object)(value), "artifact_contract_mismatch", "External source does not match its contract");
            return { receipt: null, source: reference(source) };
          } else {
            const receipt = requireCompatibleReceipt(read<ArtifactReceipt>(receiptId(project, artifact.id)), project, graph, producerId, artifactId);
            const producer = graph.nodes.find(item => item.id === producerId)!;
            git(repository.root, ["merge-base", "--is-ancestor", receipt.value.commit, repository.head]);
            requireCondition(git(repository.root, ["rev-parse", `${receipt.value.commit}^{tree}`]) === receipt.value.tree,
              "artifact_foreign", "Artifact commit and tree disagree");
            requireCondition(receipt.value.value && Array.isArray(receipt.value.value.files), "implementation_receipt_invalid", "Implementation evidence needs a file manifest, not a fabricated business value");
            if (graph.version === 2) {
              requireCondition(isRef(receipt.value.plan) && isRef(receipt.value.run), "implementation_proof_missing", "Implementation evidence must bind its accepted plan and run");
              const run = store.get<{ state: string; plan: Ref; taskId: string; commit: string; tree: string }>(receipt.value.run.id, receipt.value.run.revision);
              const plan = store.get<MachinePlan>(receipt.value.plan.id, receipt.value.plan.revision);
              requireCondition(run?.kind === "task-run" && run.hash === receipt.value.run.hash && run.value.state === "committed"
                && hashJson(run.value.plan) === hashJson(receipt.value.plan) && run.value.commit === receipt.value.commit && run.value.tree === receipt.value.tree
                && plan?.kind === "plan" && plan.hash === receipt.value.plan.hash && plan.value.projectId === project
                && plan.value.tasks.some(task => task.id === run.value.taskId && task.node === producerId && task.signature === receipt.value.signature && task.produces.includes(artifactId)),
              "implementation_proof_foreign", "Implementation receipt does not bind its accepted run");
              const paths = producer.code.filter(ref => ref.access === "write").map(ref => ref.path).sort();
              requireCondition(hashJson(receipt.value.value.files.map(file => file.path).sort()) === hashJson([...new Set(paths)])
                && receipt.value.value.files.every(file => file.hash === null || typeof file.hash === "string" && /^[a-f0-9]{64}$/.test(file.hash)),
              "implementation_manifest_invalid", "Implementation evidence must cover its exact write scope, including deletions");
            }
            for (const file of receipt.value.value.files) {
              const bytes = treeFile(repository.root, repository.head, file.path);
              requireCondition(file.hash === null ? bytes === null : bytes !== null && digest(bytes) === file.hash,
                "artifact_stale", "A previously implemented artifact changed in the current tree");
            }
            return { receipt: reference(receipt), source: null };
          }
}

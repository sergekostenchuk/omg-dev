import { Ajv } from "ajv";
import { Store, type Revision } from "../storage/store.js";
import type { Graph } from "../graph/model.js";
import { git, gitBytes, type RepositoryState } from "../runtime/environment.js";
import { sourceIsCurrent, type Source } from "../evidence/evidence.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { requireCondition } from "../errors.js";
import { hashJson, digest } from "../canonical.js";
import { receiptId, nodeSignature, type ArtifactReceipt, type TaskInput } from "./model.js";

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
            const receipt = read<ArtifactReceipt>(receiptId(project, artifact.id));
            const producer = graph.nodes.find(item => item.id === producerId)!;
            requireCondition(receipt && receipt.kind === "artifact" && receipt.value.projectId === project && receipt.value.artifact === artifact.id && receipt.value.node === producer.id
              && receipt.value.signature === nodeSignature(graph, producer) && receipt.value.contractHash === hashJson(contract.schema),
            "producer_not_ready", "A producer outside this horizon needs a compatible committed artifact");
            git(repository.root, ["merge-base", "--is-ancestor", receipt.value.commit, repository.head]);
            requireCondition(git(repository.root, ["rev-parse", `${receipt.value.commit}^{tree}`]) === receipt.value.tree,
              "artifact_foreign", "Artifact commit and tree disagree");
            for (const file of receipt.value.value.files) requireCondition(digest(gitBytes(repository.root, ["show", `${repository.head}:${file.path}`])) === file.hash,
              "artifact_stale", "A previously produced artifact changed in the current tree");
            return { receipt: reference(receipt), source: null };
          }
}

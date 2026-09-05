import type { Graph, Node } from "../graph/model.js";
import type { WriterProof } from "../ownership/owners.js";
import type { WriteGrant } from "./model.js";
import { canonical } from "../canonical.js";
import { requireCondition } from "../errors.js";

export function writeGrants(graph: Graph, node: Node, ids: Map<string, string>, resolve: (path: string) => WriterProof | null): WriteGrant[] {
  return [...new Set(node.code.filter(ref => ref.access === "write").map(ref => ref.path))].sort().map(path => {
    const owner = resolve(path);
    if (owner?.node === node.id) {
      requireCondition(canonical(owner.boundary) === canonical(node.boundary), "ownership_boundary_changed", "A continuing writer cannot silently change its authority or recovery boundary");
      return { path, from: node.id, transfer: null, producerTask: null, receipt: owner.ref };
    }
    const transfer = graph.transfers?.find(transfer => transfer.to === node.id && transfer.path === path);
    const producerTask = transfer ? ids.get(transfer.from) ?? null : null;
    if (producerTask) return { path, from: transfer!.from, transfer: transfer!.id, producerTask, receipt: null };
    if (!transfer) {
      requireCondition(!owner, "ownership_transfer_required", `The accepted owner of ${path} needs an explicit transfer`);
      return { path, from: null, transfer: null, producerTask: null, receipt: null };
    }
    const from = graph.nodes.find(node => node.id === transfer.from)!;
    requireCondition(owner?.node === transfer.from && canonical(owner.boundary) === canonical(from.boundary),
      "ownership_predecessor_missing", `The exact previous writer of ${path} has not been accepted`);
    return { path, from: transfer.from, transfer: transfer.id, producerTask: null, receipt: owner.ref };
  });
}

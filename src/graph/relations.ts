import type { Graph, Node } from "./model.js";

/** Semantic ancestry includes containment and explicit realization of another role. */
export class RefinementRelations {
  private readonly nodes: Map<string, Node>;
  private readonly parents = new Map<string, string[]>();
  constructor(graph: Graph) {
    this.nodes = new Map(graph.nodes.map(node => [node.id, node]));
    for (const node of graph.nodes) this.parents.set(node.id, node.parent ? [node.parent] : []);
    if (graph.version === 2) for (const edge of graph.edges!) if (edge.relation === "realizes") {
      const parents = this.parents.get(edge.source) ?? []; parents.push(edge.target); this.parents.set(edge.source, parents);
    }
  }
  ancestry(id: string): Node[] {
    const pending = [id], seen = new Set<string>(), result: Node[] = [];
    while (pending.length) {
      const current = pending.shift()!;
      if (seen.has(current)) continue; seen.add(current);
      const node = this.nodes.get(current); if (!node) continue;
      result.push(node); pending.push(...(this.parents.get(current) ?? []));
    }
    return result;
  }
  refines(child: string, ancestor: string): boolean { return this.ancestry(child).some(node => node.id === ancestor); }
}

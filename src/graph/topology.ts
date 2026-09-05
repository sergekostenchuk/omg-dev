import { EngineError } from "../errors.js";

export function topologicalOrder(nodes: string[], edges: readonly (readonly [string, string])[]): string[] {
  const incoming = new Map(nodes.map(id => [id, 0]));
  const outgoing = new Map(nodes.map(id => [id, new Set<string>()]));
  for (const [producer, consumer] of edges) {
    if (!incoming.has(producer) || !incoming.has(consumer)) throw new EngineError("unknown_endpoint", "Dependency endpoint does not exist");
    const targets = outgoing.get(producer)!;
    // Two different artifacts between the same operations are one scheduling dependency.
    if (!targets.has(consumer)) { targets.add(consumer); incoming.set(consumer, incoming.get(consumer)! + 1); }
  }
  const ready = nodes.filter(id => incoming.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const target of [...outgoing.get(id)!].sort()) {
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) { ready.push(target); ready.sort(); }
    }
  }
  if (order.length !== nodes.length) throw new EngineError("dependency_cycle", "Immediate dependencies contain a cycle");
  return order;
}

export function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\\x00-\x1f*?]/.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

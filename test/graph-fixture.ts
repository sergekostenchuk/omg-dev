import type { Graph, Node } from "../src/graph/model.js";

export function exampleGraph(prefix = "garden"): Graph {
  const boundary = { authority: "project-owner", writer: "engine", rollback: "revision", state: "transient" as const, provider: false };
  const root: Node = { id: `${prefix}-product`, kind: "product", parent: null, title: prefix,
    outcome: `${prefix}-result`, boundary, ports: [], code: [], tests: [] };
  const nodes: Node[] = [root];
  for (const name of ["produce", "consume"]) {
    let parent = root.id;
    for (const kind of ["block", "operation", "work"] as const) {
      const id = `${prefix}-${name}-${kind}`;
      nodes.push({ id, parent, kind, title: `${name} ${kind}`, boundary,
        outcome: name === "produce" ? `${prefix}-data` : `${prefix}-result`,
        ports: [{ id: name === "produce" ? "out" : "in", direction: name === "produce" ? "out" : "in", contract: `${prefix}-contract` }],
        code: kind === "work" ? [{ path: `${name}.txt`, access: "write", status: "planned" }] : [],
        tests: kind === "work" ? [`${id}-test`] : [],
      });
      parent = id;
    }
  }
  return { version: 1, id: `${prefix}-map`, title: prefix,
    horizon: [`${prefix}-produce-work`, `${prefix}-consume-work`],
    contracts: [{ id: `${prefix}-contract`, schema: { type: "string" } }], nodes,
    artifacts: [{ id: `${prefix}-data`, contract: `${prefix}-contract`, external: false, terminal: false },
      { id: `${prefix}-result`, contract: `${prefix}-contract`, external: false, terminal: true }],
    connectors: [{ id: `${prefix}-flow`, artifact: `${prefix}-data`, returnsTo: `${prefix}-produce-block`, wakeTest: null,
      bindings: (["block", "operation", "work"] as const).map((kind, index) => ({ level: (index + 1) as 1 | 2 | 3,
        producer: { node: `${prefix}-produce-${kind}`, port: "out" }, consumers: [{ node: `${prefix}-consume-${kind}`, port: "in" }], anchor: null })) }],
    anchors: [], joins: [], tests: nodes.filter(node => node.kind === "work").map(node => ({ id: `${node.id}-test`, node: node.id,
      command: { executable: "node", args: ["--version"] }, covers: node.id.includes("produce") ? [`${prefix}-flow`] : [] })),
  };
}

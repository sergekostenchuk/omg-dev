import { digest } from "../canonical.js";
import { requireCondition } from "../errors.js";
import type { Graph, Node, Boundary } from "./model.js";

export function buildL1(projectId: string, title: string, journey: string[]): Graph {
  requireCondition(journey.length > 0 && journey.length <= 100 && journey.every(item => typeof item === "string" && item.trim()), "journey_invalid", "A bounded journey with nonempty steps is required");
  const boundary: Boundary = { authority: "owner", writer: "engine", rollback: "forward-revision", state: "transient", provider: false };
  const contract = "change-manifest"; const outcome = `${projectId}:result`;
  const product: Node = { id: `${projectId}:product`, kind: "product", parent: null, title, outcome, boundary, ports: [], code: [], tests: [] };
  const blocks: Node[] = journey.map((step, index) => {
    const id = `block:${digest(`${projectId}\0${index}\0${step}`).slice(0,20)}`;
    return { id, kind: "block", parent: product.id, title: step, outcome: index === journey.length - 1 ? outcome : `${id}:result`, boundary,
      ports: [{ id: "in", direction: "in", contract }, { id: "out", direction: "out", contract }], code: [], tests: [] };
  });
  return { version: 1, id: `${projectId}:map`, title, horizon: [], nodes: [product, ...blocks],
    contracts: [{ id: contract, schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "object", required: ["path", "hash"], properties: { path: { type: "string" }, hash: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false } }],
    artifacts: blocks.map((block, index) => ({ id: block.outcome, contract, external: false, terminal: index === blocks.length - 1 })),
    connectors: blocks.slice(0,-1).map((block, index) => ({ id: `flow:${block.id}`, artifact: block.outcome, returnsTo: block.id, wakeTest: null,
      bindings: [{ level: 1, producer: { node: block.id, port: "out" }, consumers: [{ node: blocks[index + 1]!.id, port: "in" }], anchor: null }] })),
    anchors: [], joins: [], tests: [],
  };
}

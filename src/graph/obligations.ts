import type { Node, Obligation } from "./model.js";
export interface TestObligation { name: Obligation; status: "required" | "not_applicable"; reason: string }
export function requiredTests(node: Node): TestObligation[] {
  return [
    { name: "outcome", status: "required", reason: "observable product outcome" },
    { name: "durable_cold_read", status: node.boundary.state === "durable" ? "required" : "not_applicable", reason: `state:${node.boundary.state}` },
    { name: "restart_cold", status: node.boundary.state === "durable" ? "required" : "not_applicable", reason: `state:${node.boundary.state}` },
    { name: "provider_safety", status: node.boundary.provider ? "required" : "not_applicable", reason: `provider:${node.boundary.provider}` },
  ];
}

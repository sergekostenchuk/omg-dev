import type { Json } from "../canonical.js";

export interface Command { executable: string; args: string[] }
export type Obligation = "outcome" | "durable_cold_read" | "restart_cold" | "provider_safety";
export interface Boundary { authority: string; writer: string; rollback: string; state: "transient" | "durable"; provider: boolean }
export interface CodeRef { path: string; access: "read" | "write"; status: "existing" | "planned" }
export interface Port { id: string; direction: "in" | "out"; contract: string }
export interface Node {
  id: string; kind: "product" | "block" | "operation" | "work"; parent: string | null;
  title: string; outcome: string; boundary: Boundary; ports: Port[]; code: CodeRef[]; tests: string[];
}
export interface Endpoint { node: string; port: string }
export interface Binding { level: 1 | 2 | 3; producer: Endpoint; consumers: Endpoint[]; anchor: string | null }
export interface Connector { id: string; artifact: string; bindings: Binding[]; returnsTo: string; wakeTest: string | null }
export interface Graph {
  version: 1; id: string; title: string; horizon: string[];
  contracts: { id: string; schema: Json }[];
  nodes: Node[];
  artifacts: { id: string; contract: string; external: boolean; terminal: boolean }[];
  connectors: Connector[];
  anchors: { id: string; owner: string; outcome: string; test: string }[];
  joins: { id: string; consumer: string; connectors: string[] }[];
  tests: { id: string; node: string; command: Command; covers: string[]; obligations?: Obligation[] }[];
}
export const LEVEL = { product: 0, block: 1, operation: 2, work: 3 } as const;

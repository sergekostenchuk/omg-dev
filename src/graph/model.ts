import type { Json } from "../canonical.js";
import type { Actor, Requirement, ControlEdge, Journey, ProductTestContract, OwnershipTransfer, WorkPacket, JoinFailures, Durability } from "./semantics-model.js";

export interface Command { executable: string; args: string[] }
export type Obligation = "outcome" | "durable_cold_read" | "restart_cold" | "provider_safety";
export interface Boundary { authority: string; writer: string; rollback: string; state: "transient" | "durable"; provider: boolean }
export interface CodeRef { path: string; access: "read" | "write"; status: "existing" | "planned"; symbol?: string }
export interface Port { id: string; direction: "in" | "out"; contract: string }
/**
 * AT1 (№4091 п.4, №4098): a work's decision about expectations of its impact inventory — a test file, an addressed case
 * of it (its full chain of groups), the rest of a file after its addressed updates, a finite list of whole files kept for
 * one requirement, or the transitive remainder of the exact inventory — kept or updated, tied to the requirement or
 * contract it pins; an update addresses one file or case and names the test of this work that states the new expectation.
 */
export type ImpactEntryRef = { file: string; case?: string[] } | { file: string; rest: true } | { files: string[] } | { transitive: true };
export interface ImpactDecision { entry: ImpactEntryRef; decision: "keep" | "update"; requirement: string; expectation?: string }
/** AT1 (№4091 п.7): a required connection of the work's own result — its exact entry and contract, available from existing code or a predecessor. */
export interface Integration { entry: string; contract: string; basis: { existing: string } | { predecessor: string } }
export interface Node {
  id: string; kind: "product" | "block" | "operation" | "work"; parent: string | null;
  title: string; outcome: string; boundary: Boundary; ports: Port[]; code: CodeRef[]; tests: string[];
  purpose?: string; benefit?: string; beneficiary?: string; implements?: string[];
  impact?: ImpactDecision[]; integrations?: Integration[];
}
export interface Endpoint { node: string; port: string; codeRef?: CodeRef }
export interface Binding { level: 1 | 2 | 3; producer: Endpoint; consumers: Endpoint[]; anchor: string | null }
export interface Connector { id: string; artifact: string; bindings: Binding[]; returnsTo: string; wakeTest: string | null }
export interface Graph {
  researchObligations?: import('./task-obligation-model.js').TaskObligationBinding[];
  version: 1 | 2; id: string; title: string; horizon: string[];
  contracts: { id: string; schema: Json }[];
  nodes: Node[];
  artifacts: { id: string; contract: string; external: boolean; terminal: boolean; kind?: string; purpose?: string; durability?: Durability; sensitivity?: "public" | "project_internal" | "restricted" }[];
  connectors: Connector[];
  anchors: { id: string; owner: string; outcome: string; test: string }[];
  joins: { id: string; consumer: string; connectors: string[]; failures?: JoinFailures;
    condition?: string; required?: string[]; optional?: string[] }[];
  tests: { id: string; node: string; command: Command; covers: string[]; obligations?: Obligation[]; contract?: ProductTestContract }[];
  actors?: Actor[]; requirements?: Requirement[]; edges?: ControlEdge[]; journeys?: Journey[];
  transfers?: OwnershipTransfer[]; packets?: WorkPacket[];
}
export const LEVEL = { product: 0, block: 1, operation: 2, work: 3 } as const;

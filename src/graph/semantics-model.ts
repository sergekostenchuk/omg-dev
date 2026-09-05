import type { Command } from "./model.js";

export interface Actor { id: string; role: string; channels: string[] }
export interface Requirement { id: string; section: string; outcome: string; beneficiary: string; statement: string }
export interface ControlEdge { id: string; relation: "requires" | "realizes" | "on_success" | "on_failure" | "returns_to"; source: string; target: string; condition: string }
export interface Journey { id: string; actor: string; variant: string; entry: string; path: string[]; outcome: string; terminal: "success" | "safe_failure" | "recovery" }
export interface ProductTestContract {
  given: string[]; when: string; then: string[]; forbiddenEffects: string[];
  entrypoint: { kind: "cli" | "api" | "route" | "product_caller"; path: string; symbol: string | null; status: "existing" | "planned" };
  counterfactuals: { connector: string; mutation: "remove" | "revoke" | "substitute"; expectedFailure: string; command: Command }[];
  resourceClass: "pure" | "own_dirs" | "exclusive";
  resources: string[];
}
export interface OwnershipTransfer { id: string; path: string; from: string; to: string; condition: "producer_committed" }
export interface WorkPacket { id: string; unit: string; purpose: string; writePaths: string[] }
export interface JoinFailures { missing: string; extra: string; foreign: string; stale: string; duplicate: string; returnsTo: string }
export type Durability = "durable_source" | "durable_draft" | "versioned" | "immutable" | "reconstructible" | "evidence" | "recoverable" | "capability";

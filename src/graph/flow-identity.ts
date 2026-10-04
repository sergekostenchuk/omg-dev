import { hashJson } from "../canonical.js";
import type { Binding } from "./model.js";

/** Stable identity of an already validated flow, independent of level and consumers. */
export function bindingFlowIdentity(binding: Pick<Binding, "producer" | "anchor">): string {
  return hashJson([binding.producer.node, binding.producer.port, binding.anchor]);
}

import { spawnSync } from "node:child_process";
import { requireCondition } from "../errors.js";

export function processStart(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 });
  requireCondition(!result.error, "process_identity_unavailable", "Cannot determine process identity for safe recovery");
  return result.status === 0 ? result.stdout.trim() : "";
}

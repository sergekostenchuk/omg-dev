import { randomUUID } from "node:crypto";
import { Store, type Revision } from "../storage/store.js";
import { requireCondition } from "../errors.js";
import type { ExecutionLock } from "./model.js";
import { processStart } from "../runtime/process-identity.js";
export { processStart } from "../runtime/process-identity.js";

export function acquire(store: Store, projectId: string): Revision<ExecutionLock> {
  const previous = store.get<ExecutionLock>(`execution-lock:${projectId}`);
  requireCondition(!previous?.value.active || processStart(previous.value.pid) !== previous.value.processStart,
    "execution_busy", "This project already has an active executor");
  const started = processStart(process.pid);
  requireCondition(started, "process_identity_unavailable", "Cannot identify this executor process");
  return store.write({ id: `execution-lock:${projectId}`, kind: "execution-lock", expected: previous?.revision ?? 0,
    value: { projectId, token: randomUUID(), pid: process.pid, processStart: started, active: true } });
}
export function release(store: Store, lock: Revision<ExecutionLock>): void {
  const current = store.get<ExecutionLock>(lock.id);
  if (current?.value.token === lock.value.token && current.value.active) store.write({ id: current.id, kind: current.kind,
    expected: current.revision, value: { ...current.value, active: false } });
}

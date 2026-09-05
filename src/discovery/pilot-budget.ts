import type { Store, Revision, Write, ReadGuard } from "../storage/store.js";
import type { ReaderPilot } from "./reader-pilot.js";
import type { ModelCall } from "../runtime/model-usage.js";
import { reference } from "../pipeline/contracts.js";
import { requireCondition, EngineError } from "../errors.js";

interface Dispatch { projectId: string; calls: number; activeCall: string }

/** Reserve before spawning. This pilot is serial: competing dispatches CAS the
 * same row, and an in-flight or unmeasured attempt cannot silently be ignored. */
export function pilotDispatch(store: Store, pilot: Revision<ReaderPilot>, callId: string, requestChars: number): { writes: Write[]; guards: ReadGuard[] } {
  requireCondition(requestChars <= pilot.value.maxRequestChars, "pilot_request_limit", "The full request exceeds the configured packet limit; no model was called");
  const id = `pilot-dispatch:${pilot.value.projectId}`;
  const current = store.get<Dispatch>(id);
  if (current) {
    const active = store.get<ModelCall>(current.value.activeCall);
    if (!active || active.value.status === "running") throw new EngineError("pilot_call_active", "The previous pilot call is still running or needs recovery",
      active ? reference(active) : current.value.activeCall);
  }
  const calls = store.list<ModelCall>("model-call").filter(call => call.value.profile?.id === pilot.id);
  let tokens = 0;
  for (const call of calls) {
    if (call.value.usage) tokens += call.value.usage.inputTokens + call.value.usage.outputTokens;
    else {
      const reserve = pilot.value.unknownReserves?.find(reserve => reserve.call.id === call.id
        && reserve.call.revision === call.revision && reserve.call.hash === call.hash);
      if (!reserve) throw new EngineError("pilot_usage_unknown", "Unknown usage requires an explicit reserve in the experiment configuration; it is not measured usage", reference(call));
      tokens += reserve.tokens;
    }
  }
  requireCondition(tokens < pilot.value.maxReportedTokens, "pilot_token_limit", "Reported input/output token budget reached; no further call was started");
  requireCondition((current?.value.calls ?? 0) < pilot.value.maxCalls, "pilot_call_limit", "The shared pilot call allowance is exhausted");
  return { writes: [{ id, kind: "pilot-dispatch", expected: current?.revision ?? 0,
    value: { projectId: pilot.value.projectId, calls: (current?.value.calls ?? 0) + 1, activeCall: callId } }], guards: [reference(pilot)] };
}

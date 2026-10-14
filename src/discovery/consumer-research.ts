import type { Store, Revision } from "../storage/store.js";
import type { DiscoveryDraft } from "./discovery.js";
import type { Researcher } from "./research-runner.js";
import type { ResearchRun } from "./research-model.js";
import { rejectResearch } from "./consumer-feedback.js";
import { hashJson } from "../canonical.js";
import { EngineError, requireCondition } from "../errors.js";
import { reference, type Finding, type Ref } from "../pipeline/contracts.js";

export interface ConsumerResult {
  status: "accepted" | "paused" | "needs_owner" | "blocked";
  artifact: Ref | null; research: Ref | null; feedback: Ref | null; findings: Finding[];
  turnsUsed?: number;
}
export interface ConsumerOutcome { artifact: Ref | null; findings: Finding[]; guards: Ref[] }

/** Capture the consumer's expected revisions before each model call. The consumer
 * performs its own guarded acceptance; this loop only routes real refusals. */
export async function researchForConsumer(store: Store, researcher: Researcher, project: string, draftId: string,
  maxTurns: number, capture: () => (draft: Revision<DiscoveryDraft>) => ConsumerOutcome,
  artifact: Ref | null = null): Promise<ConsumerResult> {
  requireCondition(Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 100,
    "research_budget_invalid", "Consumer research needs a bounded turn allowance");
  let remaining = maxTurns, turnsUsed = 0;
  let result: ConsumerResult = { status: "paused", artifact, research: null, feedback: null, findings: [], turnsUsed };
  const runId = `research-run:${hashJson([project, draftId])}`;
  while (remaining > 0) {
    const consume = capture();
    const previousTurns = store.get<ResearchRun>(runId)?.value.turns ?? 0;
    const run = await researcher.run(project, draftId, remaining);
    const spent = Math.max(0, run.value.turns - previousTurns);
    turnsUsed += spent; remaining -= spent;
    result.research = reference(run); result.turnsUsed = turnsUsed;
    if (run.value.status !== "completed") return { ...result, status: run.value.status === "needs_owner" ? "needs_owner" : "paused", turnsUsed };
    const draft = store.get<DiscoveryDraft>(draftId)!;
    const consumed = consume(draft);
    result = { ...result, artifact: consumed.artifact, findings: consumed.findings };
    if (!consumed.findings.length) {
      requireCondition(consumed.artifact, "consumer_result_missing", "Acceptance requires a saved consumer result");
      return { ...result, status: "accepted", turnsUsed };
    }
    if (consumed.findings.some(finding => !finding.field)) return { ...result, status: "blocked", turnsUsed };
    result.feedback = reference(rejectResearch(store, draft, consumed.findings, consumed.guards));
  }
  return { ...result, turnsUsed };
}

export function designFindings(error: unknown, field: string, target: string, codes: ReadonlySet<string>): Finding[] {
  if (!(error instanceof EngineError) || !codes.has(error.code)) throw error;
  return error.code === "graph_invalid" && Array.isArray(error.details)
    ? error.details.map(item => ({ ...item, field }))
    : [{ code: error.code, target, message: error.message, field }];
}

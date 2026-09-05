import { tokenUsage, type TokenUsage } from "../runtime/model-usage.js";

/** Normalize CLI-reported counters only. Missing counters remain unknown;
 * cached input and reasoning output are not added twice to their totals. */
export function codexUsage(jsonl: string): TokenUsage | null {
  const terminal: Record<string, any>[] = [];
  for (const line of jsonl.split("\n").filter(Boolean)) {
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && ["turn.completed", "turn.failed"].includes(event['type'])) terminal.push(event);
  }
  if (!terminal.length || terminal.some(event => !event['usage'])) return null;
  const parts = terminal.map(event => {
    const usage = event['usage'];
    return tokenUsage({ inputTokens: usage['input_tokens'], outputTokens: usage['output_tokens'],
      cachedInputTokens: usage['cached_input_tokens'] ?? null, reasoningOutputTokens: usage['reasoning_output_tokens'] ?? null })!;
  });
  return tokenUsage({ inputTokens: parts.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: parts.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: parts.every(usage => usage.cachedInputTokens !== null) ? parts.reduce((sum, usage) => sum + usage.cachedInputTokens!, 0) : null,
    reasoningOutputTokens: parts.every(usage => usage.reasoningOutputTokens !== null) ? parts.reduce((sum, usage) => sum + usage.reasoningOutputTokens!, 0) : null });
}

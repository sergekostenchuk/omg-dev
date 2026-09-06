import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Store } from '../storage/store.js';
import type { RoleBinding } from '../runtime/environment.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { CallEstimate } from '../runtime/research-budget.js';
import { canonical, digest } from '../canonical.js';
import { reference } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';

/** Empirical CLI prediction includes all reported input/output, including wrapper
 * and reasoning costs. It is explicitly not a guaranteed transport cap. */
function comparableRole(role: RoleBinding): string {
  const args = [...role.command.args];
  // Build directories are not provider identities. Match this adapter's exact
  // entry bytes and flags, without rewriting the historical requested role.
  if (args[0] && basename(args[0]) === 'codex-stdio.js') {
    try { args[0] = `codex-stdio-sha256:${digest(readFileSync(args[0], 'utf8'))}`; }
    catch { /* An unavailable historical entry cannot prove equivalent code. */ }
  }
  return canonical({ ...role, command: { ...role.command, args } });
}
export function estimateCliCall(store: Store, project: string, role: RoleBinding, purpose: string, chars: number, packetKind?: 'initial' | 'continuation'): CallEstimate {
  const samples = store.list<ModelCall>('model-call').filter(c => c.value.projectId === project && c.value.purpose === purpose
    && comparableRole(c.value.requested) === comparableRole(role) && c.value.usage && c.value.request.chars > 0);
  requireCondition(samples.length > 0, 'budget_estimate_missing', 'No comparable measured calls: establish a forecast locally before dispatch');
  if(packetKind==='continuation'){
    const own=samples.filter(c=>c.value.packet?.kind==='continuation');
    const inputSamples=(own.length?own:samples).filter(c=>c.value.usage!.inputTokens>0);
    requireCondition(inputSamples.length>0,'budget_estimate_missing','No positive measured input exists to estimate continuation overhead');
    const inputFloor=Math.min(...inputSamples.map(c=>c.value.usage!.inputTokens));
    const density=Math.max(...inputSamples.map(c=>c.value.usage!.inputTokens/c.value.request.chars));
    const output=Math.max(...samples.map(c=>c.value.usage!.outputTokens));
    return {kind:'estimated',tokens:Math.max(1,Math.ceil(1.1*(Math.max(inputFloor,chars*density)+output))),basis:samples.map(reference),
      explanation:'Continuation estimate from observed input density and the smallest observed input as an overhead floor, plus maximum observed output/reasoning and 10%. Prefer observed continuations when available. This is empirical calibration, not a token guarantee.'};
  }
  const tokens = Math.ceil(1.1 * Math.max(...samples.map(c => {
    const usage = c.value.usage!;
    return (usage.inputTokens + usage.outputTokens) * Math.max(1, chars / c.value.request.chars);
  })));
  return { kind: 'estimated', tokens, basis: samples.map(reference), explanation: 'Maximum comparable full input+output usage, scaled upward for the complete envelope size, plus 10%. Wrapper/reasoning included in reported usage; future provider variance and hidden calls are not bounded.' };
}


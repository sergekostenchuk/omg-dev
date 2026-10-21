import { basename, isAbsolute } from "node:path";
import type { Store } from '../storage/store.js';
import type { RoleBinding } from '../runtime/environment.js';
import type { ModelCall } from '../runtime/model-usage.js';
import type { CallEstimate } from '../runtime/research-budget.js';
import { canonical } from '../canonical.js';
import { reference, uniqueRefs, type Ref } from '../pipeline/contracts.js';
import { requireCondition } from '../errors.js';
import { adapterFileHash, adapterLineage, adapterLineagePath } from './adapter-lineage.js';
import { stdioProviderByModule } from './stdio-providers.js';

/** Empirical CLI prediction includes all reported input/output, including wrapper
 * and reasoning costs. It is explicitly not a guaranteed transport cap. */
function comparableRole(store: Store, project: string, role: RoleBinding, call?: ModelCall): { key: string; basis: Ref[] } | null {
  const entry = role.command.args[0];
  if (!entry || stdioProviderByModule(basename(entry)) === null) return { key: canonical({ commandRole: role }), basis: [] };
  let hash: string | null = null; const basis: Ref[] = [];
  // LG84: the adapter is identified by its surviving bytes or an explicit lineage only;
  // the former call-runtime snapshot is no longer read.
  try {
    hash = adapterFileHash(entry);
    if (call && isAbsolute(entry)) {
      const lineage = adapterLineage(store, project, adapterLineagePath(entry));
      if (lineage) {
        if (hash !== null && hash !== lineage.value.sha256) return null; // A reused path contradicts the historical assertion.
        if (hash === null) { hash = lineage.value.sha256; basis.push(reference(lineage)); }
      }
    }
  } catch { return null; }
  if (hash === null) return null;
  return { key: canonical({ adapter: hash, flags: role.command.args.slice(1), model: role.model, effort: role.effort, speed: role.speed ?? 'inherited' }), basis };
}
export function estimateCliCall(store: Store, project: string, role: RoleBinding, purpose: string, chars: number, packetKind?: 'initial' | 'continuation'): CallEstimate {
  const current = comparableRole(store, project, role), lineageBasis: Ref[] = [];
  const samples = store.list<ModelCall>('model-call').filter(c => {
    if (!current || c.value.projectId !== project || c.value.purpose !== purpose || !c.value.usage || c.value.request.chars <= 0) return false;
    const historical = comparableRole(store, project, c.value.requested, c.value);
    if (!historical || historical.key !== current.key) return false;
    lineageBasis.push(...historical.basis); return true;
  });
  requireCondition(samples.length > 0, 'budget_estimate_missing', 'No comparable measured calls: establish a forecast locally before dispatch');
  const basis = uniqueRefs([...samples.map(reference), ...lineageBasis]);
  if(packetKind==='continuation'){
    const own=samples.filter(c=>c.value.packet?.kind==='continuation');
    const inputSamples=(own.length?own:samples).filter(c=>c.value.usage!.inputTokens>0);
    requireCondition(inputSamples.length>0,'budget_estimate_missing','No positive measured input exists to estimate continuation overhead');
    const inputFloor=Math.min(...inputSamples.map(c=>c.value.usage!.inputTokens));
    const density=Math.max(...inputSamples.map(c=>c.value.usage!.inputTokens/c.value.request.chars));
    const output=Math.max(...samples.map(c=>c.value.usage!.outputTokens));
    return {kind:'estimated',tokens:Math.max(1,Math.ceil(1.1*(Math.max(inputFloor,chars*density)+output))),basis,
      explanation:'Continuation estimate from observed input density and the smallest observed input as an overhead floor, plus maximum observed output/reasoning and 10%. Prefer observed continuations when available. This is empirical calibration, not a token guarantee.'};
  }
  const tokens = Math.ceil(1.1 * Math.max(...samples.map(c => {
    const usage = c.value.usage!;
    return (usage.inputTokens + usage.outputTokens) * Math.max(1, chars / c.value.request.chars);
  })));
  return { kind: 'estimated', tokens, basis, explanation: 'Maximum comparable full input+output usage, scaled upward for the complete envelope size, plus 10%. Adapter identity uses its surviving file bytes or an explicit immutable operator lineage. Wrapper/reasoning included in reported usage; future provider variance and hidden calls are not bounded.' };
}

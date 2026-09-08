import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import type { ModelCall } from '../runtime/model-usage.js';
import { prepareScopeWrite, researchScope, type ResearchScope } from './research-scope.js';
import { validateObligationPolicy, type ObligationPolicy } from './obligation-policy.js';

/** Applying owner policy changes one scope revision, never the old run or budget.
 * The immutable successor itself is the retry receipt; no extra status record. */
export function applyObligationPolicy(store: Store, project: string, expectedScope: Ref, policy: ObligationPolicy): Revision<ResearchScope> {
  requireCondition(isRef(expectedScope) && expectedScope.id === `research-scope:${project}:R2` && policy && typeof policy === 'object',
    'obligation_application_invalid', 'Application must name the exact scope and project');
  const original = store.get<ResearchScope>(expectedScope.id, expectedScope.revision);
  requireCondition(original?.kind === 'research-scope' && original.hash === expectedScope.hash && original.value.projectId === project,
    'obligation_application_stale', 'The requested scope revision is missing or foreign');
  const value: ResearchScope = { ...original.value, policy };
  validateObligationPolicy(store, value);
  const completed = () => {
    const next = store.get<ResearchScope>(original.id, original.revision + 1);
    return next?.kind === 'research-scope' && canonical(next.value) === canonical(value) ? next : null;
  };
  const replay = completed();
  if (replay) return replay;
  const current = researchScope(store, project);
  requireCondition(current && canonical(reference(current)) === canonical(expectedScope),
    'obligation_application_stale', 'Apply to the current exact scope; do not overwrite a later owner revision');
  if (canonical(current.value) === canonical(value)) return current;
  const prepared = prepareScopeWrite(store, value, current.revision);
  const counterId = `project-dispatch:${hashJson(project)}`;
  const counter = store.get<{ projectId: string; serial: number }>(counterId);
  requireCondition(!counter || (counter.kind === 'project-dispatch' && counter.value.projectId === project
    && Number.isSafeInteger(counter.value.serial) && counter.value.serial >= 0 && counter.value.serial < Number.MAX_SAFE_INTEGER),
  'obligation_application_dispatch_invalid', 'Application requires a valid project dispatch counter');
  requireCondition(!store.list<ModelCall>('model-call').some(call => call.value.projectId === project && call.value.status === 'running'),
    'obligation_application_busy', 'Preserve the active call; finish or recover it before changing the research scope');
  try {
    return store.writeMany<ResearchScope>([prepared.write,
      { id: counterId, kind: 'project-dispatch', expected: counter?.revision ?? 0,
        value: { projectId: project, serial: (counter?.value.serial ?? 0) + 1 } }], prepared.guards)[0]!;
  } catch (error) {
    if (error instanceof EngineError && ['input_stale', 'revision_conflict'].includes(error.code)) {
      const concurrent = completed();
      if (concurrent) return concurrent;
    }
    throw error;
  }
}

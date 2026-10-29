import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store, Write } from '../storage/store.js';
import { readResponseCorrectionChain } from './response-correction.js';

export interface ApplicationResponseCorrection {
  contract: 'application-response-correction/v1';
  root: Ref;
  previous: Ref;
  generation: number;
  failure: Record<string, unknown>;
}
export interface CorrectableApplication {
  [key: string]: any;
  projectId: string;
  session: Ref;
  context: Record<string, any>;
  responseCorrection?: ApplicationResponseCorrection;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function invalid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'research_response_retry_invalid', message);
}
export const responseCorrectionApplicationId = (root: Ref, generation: number) =>
  `${root.id}:response-correction:${hashJson([root, generation])}`;

function exact<T extends CorrectableApplication>(store: Store, ref: Ref, kind: string): Revision<T> {
  invalid(isRef(ref), 'A role correction needs an exact application');
  const row = store.get<T>(ref.id, ref.revision);
  invalid(row?.kind === kind && row.revision === 1 && same(reference(row), ref)
    && row.hash === hashJson(row.value), 'The role correction lost its immutable application origin');
  return row;
}

/** A role leaf retains its own complete original admission. This branch only
 * recognizes a new generation of that application, with unchanged material
 * and exact saved feedback. Paid refusal proof is also required by the role's
 * full admission and historical projector before use of this generation. */
export function correctingApplicationLeaf<T extends CorrectableApplication, A extends {
  application: Revision<T>; context: Record<string, any>;
}>(store: Store, application: Revision<T>, original: (ref: Ref) => A): A | null {
  const marker = application.value.responseCorrection;
  if (marker === undefined) return null;
  invalid(marker && Object.keys(marker).sort().join(',')==='contract,failure,generation,previous,root'
    && marker.contract === 'application-response-correction/v1'
    && isRef(marker.root) && isRef(marker.previous) && Number.isSafeInteger(marker.generation)
    && marker.generation > 0 && marker.failure && typeof marker.failure === 'object'
    && !Array.isArray(marker.failure), 'The correcting application lost its closed generation or feedback');
  const root = exact<T>(store, marker.root, application.kind);
  invalid(root.value.responseCorrection === undefined && application.id === responseCorrectionApplicationId(marker.root, marker.generation),
    'A correcting refusal cannot become a new correction root');
  const admission = original(marker.root);
  const context = { ...admission.context,
    failures: [...(admission.context.failures ?? []), marker.failure] };
  invalid(application.revision === 1 && same(application.value, {
    ...root.value, context, responseCorrection: marker,
  }), 'The correction changed the original role, subject, request, guards or cursor');
  return { ...admission, application, context };
}

/** Discovery always chooses a saved generation; it never creates one during
 * ordinary restoration. Deterministic ids make concurrent correction entries
 * contend on the same application and physical reservation. */
export function latestResponseApplication<T extends CorrectableApplication>(store: Store, root: Revision<T>): Revision<T> {
  let latest = root;
  for (let generation = 1;; generation++) {
    const row = store.get<T>(responseCorrectionApplicationId(reference(root), generation), 1);
    if (!row) return latest;
    latest = exact<T>(store, reference(row), root.kind);
    const marker = latest.value.responseCorrection;
    invalid(marker && same(marker.root, reference(root)) && marker.generation === generation,
      'The saved correcting generation belongs to another application');
  }
}

export interface ApplicationCorrectionOutcome {
  kind: 'response' | 'provider-failed' | 'terminal';
  call: Revision<any>;
  request: Ref;
  response: Ref | null;
  payload?: unknown;
}
export interface ApplicationCorrectionReader<T extends CorrectableApplication> {
  read(ref: Ref): Revision<T>;
  outcome(application: Revision<T>): Promise<ApplicationCorrectionOutcome | null>;
  project(application: Revision<T>, paid: ApplicationCorrectionOutcome): Promise<unknown>;
  formCodes: readonly string[];
}

export async function readApplicationResponseCorrection<T extends CorrectableApplication>(store: Store,
  project: string, rootRef: Ref, reader: ApplicationCorrectionReader<T>) {
  const root = reader.read(rootRef);
  invalid(root.value.projectId === project && root.value.responseCorrection === undefined,
    'Select the original paid form refusal of this project');
  const latest = latestResponseApplication(store, root);
  const records = new Map<string, Revision<T>>(), outcomes = new Map<string, ApplicationCorrectionOutcome | null>();
  const failures = new Map<string, EngineError | null>();
  const seen = new Set<string>();
  for (let row = latest;;) {
    invalid(!seen.has(row.id), 'The role correction has a cyclic predecessor');
    seen.add(row.id); records.set(row.id, row);
    const paid = await reader.outcome(row); outcomes.set(row.id, paid);
    let failure: EngineError | null = null;
    if (paid?.kind === 'response') {
      try { await reader.project(row, paid); }
      catch (error) {
        if (!(error instanceof EngineError) || !reader.formCodes.includes(error.code)) throw error;
        failure = error;
      }
    }
    failures.set(row.id, failure);
    if (row.id === root.id) break;
    const marker = row.value.responseCorrection;
    invalid(marker && same(marker.root, rootRef), 'The role correction lost its original refusal');
    row = reader.read(marker.previous);
  }
  const chain = readResponseCorrectionChain(rootRef, {
    read: ref => { const row = records.get(ref.id); invalid(row && same(reference(row), ref),
      'The correction lost an exact predecessor'); return row; },
    latest: () => latest,
    previous: value => value.responseCorrection?.previous ?? null,
    follows: (before, after) => !!after.responseCorrection
      && after.responseCorrection.generation === (before.responseCorrection?.generation ?? 0) + 1
      && same(after.responseCorrection.root, rootRef) && before.projectId === after.projectId
      && same(before.session, after.session),
    formFailure: row => failures.get(row.id) ?? null,
    responseFreeFailure: row => outcomes.get(row.id)?.kind === 'provider-failed',
  });
  const paid = outcomes.get(root.id);
  invalid(paid?.kind === 'response' && paid.response, 'Correction requires the exact paid invalid model response');
  const failure = { contract: 'discovery-response-correction/v1', root: rootRef,
    role: root.value.contract, call: reference(paid.call), request: paid.request, response: paid.response,
    code: chain.failure.code, message: chain.failure.message, validation: chain.failure.details ?? null,
    previousResponse: paid.payload,
    instruction: chain.failure.code === 'research_context_incomplete'
      ? 'The paid terminal answer arrived before all required context was read. Keep this exact original request and role. Use read_context for the next required missing page; return a terminal result only after complete required coverage. This addressed entry permits one physical call.'
      : chain.failure.code === 'research_no_progress'
      ? 'The requested context page was already delivered. Keep this exact original request and role, and use the material already read instead of requesting the same page again. Answer from the delivered material, or read only a genuinely missing required page. This addressed entry permits one physical call.'
      : 'Correct only the invalid response form for this exact original request and role. Return the complete closed response form.' };
  for (const row of chain.chain.slice(1)) invalid(same(row.value.responseCorrection!.failure, failure),
    'The correcting application changed its exact original refusal feedback');
  return { ...chain, failure, paid: outcomes.get(latest.id) ?? null };
}

export function responseCorrectionApplicationWrite<T extends CorrectableApplication>(correction: Awaited<
  ReturnType<typeof readApplicationResponseCorrection<T>>>): Write {
  invalid(correction.retry, 'This correction has already consumed its one content response');
  const root = correction.root, generation = (correction.latest.value.responseCorrection?.generation ?? 0) + 1;
  const marker: ApplicationResponseCorrection = { contract: 'application-response-correction/v1',
    root: reference(root), previous: reference(correction.latest), generation, failure: correction.failure };
  return { id: responseCorrectionApplicationId(reference(root), generation), kind: root.kind, expected: 0,
    value: { ...root.value, context: { ...root.value.context,
      failures: [...(root.value.context.failures ?? []), correction.failure] }, responseCorrection: marker } };
}

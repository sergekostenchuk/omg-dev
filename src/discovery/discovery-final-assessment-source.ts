import { canonical, hashJson } from '../canonical.js';
import { EngineError, requireCondition } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Revision, Store } from '../storage/store.js';
import { DISCOVERY_FINAL_APPLICATION_KIND, DISCOVERY_FINAL_PAID_RESULT, DISCOVERY_FINAL_PAID_RESULT_KIND,
  readDiscoveryFinalExecutionAt, type DiscoveryFinalApplication, type DiscoveryFinalExecution,
  type DiscoveryFinalPaidResult } from './discovery-final-execution.js';
import type { DiscoveryFinalSession } from './discovery-final-session.js';
import type { V7FinalBundle } from './v7-final-contracts.js';
import { prepareDiscoveryFinalAssessmentSubject, type DiscoveryFinalAssessmentPacket } from './discovery-final-assessment-subject.js';

/** DR7 7a.4 (codex-omg2 №16021 п.1): the read-only source of the D7 assessment — one exact paid D7 result, proven
 * through its terminal execution, and the assessment packet built from its whole bundle. The paid result names the
 * cursor its application was made on; the terminal cursor is the `after` of that proven applied application, never
 * today's head. The source keeps the paid result with its session, application, call, request and response and the
 * whole D7 subject: the verbatim assignment, the paid D6, partial reasons and both sides of every contradiction. It is
 * not a paid assessment and not an acceptance; nothing here writes, calls or pays. */
export const DISCOVERY_FINAL_ASSESSMENT_SOURCE = 'discovery-final-assessment-source/v1' as const;

export interface DiscoveryFinalAssessmentSource {
  contract: typeof DISCOVERY_FINAL_ASSESSMENT_SOURCE;
  projectId: string;
  paid: Revision<DiscoveryFinalPaidResult>;
  /** The exact applied application whose `after` is the terminal cursor below. */
  application: Revision<DiscoveryFinalApplication>;
  terminal: Revision<DiscoveryFinalExecution>;
  prepared: Revision<DiscoveryFinalSession>;
  grounds: { session: Ref; application: Ref; call: Ref; request: Ref; response: Ref };
  bundle: V7FinalBundle;
  packet: DiscoveryFinalAssessmentPacket;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const object = (value: unknown): value is Record<string, any> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
function valid(condition: unknown, message: string): asserts condition {
  requireCondition(condition, 'discovery_final_assessment_source_invalid', message);
}
/** One plain JSON snapshot of the caller's Ref: exactly id, revision and hash, read once. */
function snapshotRef(ref: unknown): Ref {
  let snapshot: unknown;
  try { snapshot = JSON.parse(canonical(ref)); }
  catch { throw new EngineError('discovery_final_assessment_source_invalid', 'The assessment source needs an exact paid result reference'); }
  valid(isRef(snapshot) && object(snapshot) && Object.keys(snapshot).sort().join(',') === 'hash,id,revision',
    'The assessment source needs an exact paid result reference');
  return snapshot;
}
function exact<T>(store: Store, ref: Ref, kind: string, message: string): Revision<T> {
  const row = store.get<T>(ref.id, ref.revision);
  // PAID-SOURCE-SHAPE-01: a consistent hash over a value that is no record is refused before any field is read.
  valid(row?.kind === kind && same(reference(row), ref) && hashJson(row.value as never) === row.hash && object(row.value), message);
  return row;
}

/** Read the exact paid D7 result as the source of its assessment: the terminal execution is proven by the shared
 * historical reader from the applied application of this result, and the assessment packet is prepared from the
 * whole proven bundle over the exact paid D6 of the same final subject. */
export async function readDiscoveryFinalAssessmentSourceAt(store: Store, project: string,
  paidResultRef: unknown): Promise<DiscoveryFinalAssessmentSource> {
  valid(typeof project === 'string' && project.length > 0, 'The assessment source needs its project');
  const at = snapshotRef(paidResultRef);
  const paid = exact<DiscoveryFinalPaidResult>(store, at, DISCOVERY_FINAL_PAID_RESULT_KIND,
    'The exact paid D7 result is missing, foreign or changed');
  valid(object(paid.value) && paid.value.contract === DISCOVERY_FINAL_PAID_RESULT && paid.value.projectId === project
    && ['prepared', 'session', 'application', 'call', 'request', 'response'].every(field => isRef(paid.value[field as keyof DiscoveryFinalPaidResult])),
  'The paid D7 result has another project or an incomplete form');
  // The paid result names the cursor its application was made on; the terminal cursor is that application's own
  // applied `after`, not a later head of the execution.
  const application = exact<DiscoveryFinalApplication>(store, paid.value.application, DISCOVERY_FINAL_APPLICATION_KIND,
    'The application of the paid D7 result is missing or changed');
  valid(same(application.value.session, paid.value.session), 'The paid D7 result names another application cursor');
  // As in the shared historical reader, the first application revision is applied exactly once, as revision 2.
  valid(application.revision === 1, 'The paid D7 result names a later application revision');
  const appliedRow = store.get<DiscoveryFinalApplication>(application.id, 2);
  valid(appliedRow, 'The application of the paid D7 result was never applied');
  const applied = exact<DiscoveryFinalApplication>(store, reference(appliedRow), DISCOVERY_FINAL_APPLICATION_KIND,
    'The applied application of the paid D7 result is missing or changed');
  // The application keeps the claim of its call (its first revision) and the received terminal revision of that same
  // call; the paid result names the terminal one.
  valid(applied.value.state === 'applied' && isRef(applied.value.after) && isRef(applied.value.call) && isRef(applied.value.received)
    && same(applied.value.received, paid.value.call) && applied.value.call.id === paid.value.call.id,
  'The applied application does not name its terminal cursor and paid call');
  const execution = await readDiscoveryFinalExecutionAt(store, project, applied.value.after);
  valid(execution.output && same(reference(execution.output), at) && same(execution.output.value, paid.value),
    'The terminal execution does not prove this exact paid D7 result');
  valid(same(execution.prepared.value.subject, paid.value.subject) && same(execution.session.value.subject, paid.value.subject),
    'The paid D7 result belongs to another final subject');
  const bundle = paid.value.projection.result.bundle;
  const packet = await prepareDiscoveryFinalAssessmentSubject(store, project, paid.value.subject.basis.assessment, bundle);
  valid(same(packet.subject.subject, paid.value.subject) && same(packet.candidate, bundle),
    'The assessment packet is not the one of this paid bundle and its final subject');
  const { session, application: app, call, request, response } = paid.value;
  return structuredClone({ contract: DISCOVERY_FINAL_ASSESSMENT_SOURCE, projectId: project, paid, application: applied,
    terminal: execution.session, prepared: execution.prepared, grounds: { session, application: app, call, request, response },
    bundle, packet });
}

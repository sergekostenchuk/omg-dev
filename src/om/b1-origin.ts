import { UPSTREAM_STAGES } from "../discovery/requirements.js";
import { stageId, type Stage } from "../pipeline/contracts.js";
import type { Revision } from "../storage/store.js";
import type { IntegrityRecordCheck } from "../storage/fsck.js";
import { isPlainObject } from "./refusal.js";

// These producer address spaces require B1 even when their saved envelope is incomplete.
// Shared pre-B1 records are handled below by their provenance fields, never by arbitrary text.
const recordObject = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const B1_PRODUCERS = Object.freeze([
  'horizon', 'om-horizon', 'series-transition', 'om-horizon-issuance', 'om-series-applied', 'om-series-discarded', 'om-series-era', 'om-analysis-admission',
  'block-weight', 'om-input-decision', 'om-gap', 'om-gap-lines', 'om-candidate',
  'om-answer-task', 'om-mc1-question', 'om-answer', 'om-answer-index', 'om-routes', 'om-answers-gate',
  'om-owner-gap-assignment', 'om-obligation-transfer', 'om-obligation-basis', 'om-obligations',
  'om-question-packet', 'om-part-response', 'om-part-result', 'om-part-assembly',
  'om-assessment-intent', 'om-assessment-result',
  'om-completion-owner', 'om-completion-era', 'om-completion-assignment', 'om-completion-work', 'om-completion-close', 'om-completion-cessation', 'om-completion-packet',
  'om-read-delivery', 'om-read-deliveries', 'om-model-cycle', 'om-model-exchange',
  'om-model-application-rejection', 'om-neighbors', 'om-atomic-gate', 'om-works-acceptance', 'om-work-rejection',
]);
function b1Address(project: string, id: unknown): boolean {
  // H1: the one pass of a project starts from its exact first B1, so its record is B1-born even when incomplete.
  return typeof id === 'string' && (id === `om-input:${project}` || id === `om-feasibility:${project}` || id === `om-series-current:${project}`
    || id === `om-run:${project}`
    || B1_PRODUCERS.some(namespace => id.startsWith(`${namespace}:${project}:`))
    || [2, 3].some(level => id === `om-frame:${project}:${level}`)
    || ['part', 'assembly'].some(source => id.startsWith(`om-proposal:${project}:${source}:`))
    || id.startsWith(`repair-series:${project}:mechanism:`));
}
// Paths end at declared Ref slots; * expands arrays only. Never descend into a leaf's contents.
function provenanceValues(value: unknown, path: string): unknown[] {
  let values: unknown[] = [value];
  for (const field of path.split('.')) values = values.flatMap(item => field === '*'
    ? Array.isArray(item) ? item : [] : recordObject(item) && Object.hasOwn(item, field) ? [item[field]] : []);
  return values;
}
function b1Reference(project: string, value: unknown): boolean {
  // Incomplete references still name lost dependencies, but arbitrary nested ids do not.
  return recordObject(value) && b1Address(project, value['id']);
}
const under = (prefix: string, paths: readonly string[]) => paths.map(path => `${prefix}.${path}`);
const FRAME_ORIGIN_REFS = Object.freeze(['graph', 'horizon', 'layer', 'frame', 'upper.horizon', 'upper.frame']);
const PROPOSAL_ORIGIN_REFS = Object.freeze([...under('frame', FRAME_ORIGIN_REFS), 'proposals.*']);
const GAP_ORIGIN_REFS = Object.freeze(['records.*', 'sources.input', 'sources.horizon', 'sources.graph',
  ...under('sources.operations', PROPOSAL_ORIGIN_REFS), 'sources.works.layer',
  ...under('sources.works', PROPOSAL_ORIGIN_REFS)]);
const CALL_ORIGIN_REFS = Object.freeze(['series', 'basis.series', 'basis.hold', 'basis.assessment', 'admission.routes',
  ...under('admission.gaps', GAP_ORIGIN_REFS)]);
interface ProvenanceFields {
  readonly refs: readonly string[];
  readonly sources: readonly string[];
  readonly owners: readonly string[];
}
function provenance(refs: readonly string[], sources: readonly string[] = [], owners: readonly string[] = []): ProvenanceFields {
  return Object.freeze({ refs: Object.freeze([...refs]), sources: Object.freeze([...sources]), owners: Object.freeze([...owners]) });
}
// Closed producer schema map. Unknown namespaces are not evidence of B1; fixed B1 addresses above are.
const B1_SHARED_ORIGINS: Readonly<Record<string, ProvenanceFields>> = Object.freeze({
  'om-assessment-intent': provenance(['source.modelCall', 'source.call', 'source.packet', 'source.response',
    'source.question', 'candidates.*.question', 'fact.question', 'originalSeries', 'series',
    'dispatch.adapter', 'dispatch.config', 'originalGuards.*']),
  'om-assessment-result': provenance(['intent', 'assessor', 'accepted', 'index', 'binding', 'assignment', 'work', 'call', 'receipt',
    'cause.source', 'cause.prerequisite.source', 'cause.prerequisite.context', 'cause.prerequisite.physical', 'cause.prerequisite.packet', 'cause.replacement', 'cause.proof', 'cause.appeared', 'cause.graph', 'cause.change.currentPointer']),
  'om-completion-owner': provenance(['series', 'previous', 'plan.routes']),
  'om-completion-era': provenance(['opening', 'binding']),
  'om-completion-assignment': provenance(['binding', 'parent', 'source']),
  'om-completion-packet': provenance(['binding', 'root', 'packet']),
  'om-completion-work': provenance(['binding', 'previous', 'assignments.*', 'products.*', 'journal', 'closed']),
  'om-completion-cessation': provenance(['binding', 'assignment', 'work', 'packet', 'call', 'ledger', 'physical', 'exchange', 'rejection',
    'cause.source', 'cause.prerequisite.source', 'cause.prerequisite.context', 'cause.prerequisite.physical', 'cause.prerequisite.packet', 'cause.replacement', 'cause.proof', 'cause.appeared', 'cause.graph', 'cause.change.currentPointer']),
  'om-completion-close': provenance(['binding', 'work', 'series', 'ledger', 'journal', 'claim.accepting.*', 'claim.cancelling.*', 'waiting.*']),
  'om-series-era': provenance(['firstManaged', 'origin.applied', 'origin.membership', 'origin.pointer']),
  'om-series-membership': provenance(['activation', 'roots.*.root']),
  'om-analysis-intent': provenance(['request.series', 'request.hold', 'sources.series', 'sources.journal', 'sources.holds.*',
    'report.guards.*', ...under('call', CALL_ORIGIN_REFS)], [], ['call.owner']),
  'om-proposal': provenance(['base.graph', 'base.frame', 'replaces.*.base.graph', 'verdict.candidate', 'verdict.gate',
    'verdict.refusal.at.ref', ...under('verdict.request', PROPOSAL_ORIGIN_REFS)]),
  'repair-series': provenance(['predecessor', 'inherited.*.outcome.achieved.*.basis', 'attempts.*.outcome.achieved.*.basis',
    'activation.registered', 'activation.applied', 'activation.prepared', 'activation.activeBasis', 'attempts.*.terminal',
    'continuations.*.review', 'continuations.*.input', 'continuations.*.confirmation', 'continuations.*.decision',
    'escalations.*.review', ...under('scope', GAP_ORIGIN_REFS), 'admissions.*.basis.routes',
    ...under('admissions.*.basis.gaps', GAP_ORIGIN_REFS)], [], ['owner']),
  'call-record': provenance([...CALL_ORIGIN_REFS, 'dispatch.adapter', 'dispatch.config'], [], ['owner']),
  'om-call-ledger': provenance(['calls.*.call', ...under('calls.*', CALL_ORIGIN_REFS)], [], ['calls.*.owner']),
  'om-origin-hold': provenance(['series', 'lift.record'], ['lift.basis.*'], ['owner']),
  'om-origin-analysis': provenance([], ['basis.*'], ['owner']),
  'om-origin-decision': provenance([], [], ['owner']),
  'om-stop-review': provenance([], [], ['owner']),
  'om-owner-decision': provenance([], [], ['owner']),
  'om-input-fix': provenance(['input']),
  'om-unit-refusal': provenance([], ['refusals.*.origin.sources.*']),
  'om-refusal-journal': provenance(['rows.*.source'], ['rows.*.origin.sources.*', 'classifications.*.basis.*']),
  'model-call': provenance(['request.record', 'response.record', 'recovery', 'profile', 'packet.archive', 'budget.segment',
    'runtime.declaration', 'om.request.dispatch.adapter', 'om.request.dispatch.config', 'om.input', 'om.call', 'om.exchange', 'om.part.proposal', 'om.part.result', 'om.diagnostic',
    'om.completionOwner.binding', 'om.completionOwner.assignment', 'om.completionOwner.call', 'om.completionOwner.packetBasis',
    'transport.completionOwner.binding', 'transport.completionOwner.assignment', 'transport.completionOwner.call', 'transport.completionOwner.packetBasis',
    'om.rejection', 'om.completion', 'om.failure.at.ref', 'om.request.packet', 'transport.exchange', 'transport.request.call',
    'om.admission.series', 'om.admission.pointer', 'om.terminal.source', 'om.terminal.call', 'om.terminal.series',
    'om.terminal.admission.series', 'om.terminal.admission.pointer', 'om.terminal.change.series', 'om.terminal.change.pointer',
    'om.terminal.change.applied', 'om.terminal.change.currentPointer']),
  'om-model-transport': provenance(['request.call', 'call']),
  'graph-layer': provenance(['acceptance.frame', 'inputs.*', 'obligations.*.inputs.*', 'layerProofs.*.inputs.*',
    'projection.researchObligations.*.scope']),
  'graph': provenance(['researchObligations.*.scope']),
  'discovery': provenance(['inputs.*', 'derivations.*.source']),
  'stage': provenance(['inputs.*', 'proofs.*']),
  'plan': provenance(['graph', 'environment', 'stage', 'feasibility', 'guards.*', 'tasks.*.inputs.*.receipt',
    'tasks.*.inputs.*.source', 'tasks.*.ownership.*.receipt', 'graphSnapshot.researchObligations.*.scope',
    'tasks.*.researchObligations.*.requirement.scope',
    'tasks.*.researchObligations.*.requirement.original.record',
    'tasks.*.researchObligations.*.requirement.documentaryAllowance.sources.*',
    'tasks.*.researchObligations.*.requirement.runtimeCheck.script',
    'tasks.*.researchObligations.*.requirement.runtimeCheck.dependencies.*']),
  'runtime-observation': provenance(['scope', 'environment', 'context.*', 'check.script', 'check.dependencies.*']),
  'writer-index': provenance([]),
});
const STAGE_CONTENT_ORIGINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'om-g2': Object.freeze(['content.feasibility']), compilation: Object.freeze(['content.plan']),
  execution: Object.freeze(['content.result']),
});
function namedB1References(project: string, value: unknown, paths: readonly string[]): boolean {
  return paths.some(path => provenanceValues(value, path).some(ref => b1Reference(project, ref)));
}
function b1OriginSource(project: string, value: unknown): boolean {
  if (!recordObject(value)) return false;
  if (b1Reference(project, value['ref'])) return true;
  const context = value['context'];
  if (!recordObject(context)) return false;
  if (context['kind'] === 'frame') return namedB1References(project, context['request'], FRAME_ORIGIN_REFS);
  if (context['kind'] === 'proposal') return namedB1References(project, context['request'], PROPOSAL_ORIGIN_REFS);
  return false;
}
function savedB1Origin(project: string, record: Revision<unknown>): boolean {
  if (b1Address(project, record.id)) return true;
  const value = record.value;
  if (!recordObject(value)) return false;
  const namespace = record.id.split(':')[0]!;
  const belongs = namespace === 'runtime-observation' ? value['projectId'] === project
    : namespace === 'writer-index' ? value['project'] === project
    : record.id.startsWith(`${namespace}:${project}:`) || record.id === `${namespace}:${project}`;
  if (!belongs || !Object.hasOwn(B1_SHARED_ORIGINS, namespace)) return false;
  if (namespace === 'model-call' && !record.id.startsWith(`model-call:${project}:om:`)) return false;
  const fields = B1_SHARED_ORIGINS[namespace]!;
  return namedB1References(project, value, fields.refs)
    || fields.sources.some(path => provenanceValues(value, path).some(source => b1OriginSource(project, source)))
    || fields.owners.some(path => provenanceValues(value, path).some(owner => recordObject(owner)
      && owner['kind'] === 'mechanism' && owner['mechanism'] === 'M5:addressing'))
    || namespace === 'model-call' && b1Address(project, value['draftId'])
    || namespace === 'stage' && (Object.entries(STAGE_CONTENT_ORIGINS).some(([stage, paths]) =>
      record.id === stageId(project, stage as Stage) && namedB1References(project, value, paths))
      || UPSTREAM_STAGES.some(stage => record.id === stageId(project, stage))
        && namedB1References(project, value, ['content.draft', 'content.graph']))
    || namespace === 'writer-index' && value['contract'] === 'writer-index/om-m8-v1'
    || namespace === 'repair-series' && (value['contract'] === 'om-repair-series/v2'
      || recordObject(value['activation']) && value['activation']['contract'] === 'om-series-activation/v1')
    || namespace === 'om-series-membership' && value['mode'] === 'transition-managed';
}
/** G7: collect provenance from the revisions fsck already decodes in its one committed snapshot.
 * Historical bodies retain their ownership; a newer head cannot erase an earlier B1 origin. */
export function b1OriginCheck(project: string): IntegrityRecordCheck {
  const id = `om-input:${project}`;
  let first = false, origin = false;
  return {
    record(record) {
      if (record.id === id && record.revision === 1) first = true;
      if (!origin && savedB1Origin(project, record)) origin = true;
    },
    findings: () => first || !origin ? [] : [{ code: "record_missing", id, revision: 1,
      field: "revision", ref: null, message: "OM provenance requires the exact first B1 input" }],
  };
}

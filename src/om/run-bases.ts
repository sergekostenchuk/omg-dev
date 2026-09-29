import { canonical, hashJson, type Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import { UPSTREAM_STAGES, type UpstreamStage } from "../discovery/requirements.js";
import { reference, type Ref } from "../pipeline/contracts.js";
import { Store, type Revision, type TransactionGuard, type Write } from "../storage/store.js";
import { prepareHorizon, prepareHorizonIssuance, type HorizonRequest } from "./horizon.js";
import { prepareOmInput, type OmInputRecord } from "./input.js";
import { prepareGaps, type GapReadRequest, type GapRequest } from "./gaps.js";
import { readAcceptedFrameLayer, readUnacceptedLayer, type LayerBasis } from "./layer-basis.js";
import { prepareLayerAcceptance } from "./frame-obligations.js";
import { prepareQuestionTasks } from "./question-packet.js";
import { prepareBlockQueue, prepareMachinePath, QUEUE_POLICY_VERSION, type QueueRequest } from "./queue.js";
import { prepareSeriesActivation, readAnySeriesAt, readAppliedSeriesTransition, readCurrentSeriesPointer, readSeriesMembership, seriesAddress,
  type AnyRepairSeries, type RepairSeries } from "./series.js";
import { prepareSeriesTransition, readPreparedSeriesTransition } from "./series-transition.js";
import { readRoutes, prepareRoutes, type RoutesRecord, type RoutesRequest } from "./routes.js";
import { writeGuarded } from "./refs.js";
import { delivered, isPlainObject, refused, sealed, type OmResult, type Refusal, type Sealed } from "./refusal.js";
import { readRun, runId, startRun, type RunRecord } from "./run.js";

/**
 * H1.1 — the machine producer of the bases of an OM pass. From the accepted stages it takes the common B1, the pass
 * and its launch intent, the G2 horizon of every intended outcome, the D1 gaps, the D5 fact tasks, the M6 routes and
 * the C1 queue, each through its own common producer and at a deterministic address. No choice is asked of a person:
 * the intent is fixed when the pass is launched (№1852) and everything else is derived from exact accepted sources.
 * It never calls a model, opens an attempt or advances the pass; it keeps no record of its own (№1844).
 */
export const RUN_BASES_POLICY = "om-run-bases/v1";
export const RUN_BASES_CODES = sealed(["run_bases_request_invalid", "run_bases_work_open", "run_bases_terminal", "run_bases_basis_stale"] as const);
/**
 * The result form of every fact task this producer issues (№1844 п.9, №1860 п.4): the answer to the exact question,
 * a nonempty string. It is not evidence of truth — E5 and the answer's own sources still decide that.
 */
export const FACT_RESULT_FORM = sealed({ type: "object", required: ["answer"], properties: { answer: { type: "string", minLength: 1 } },
  additionalProperties: false });

export interface RunBases { readonly horizon: Ref; readonly queue: Ref; readonly routes: Ref; readonly sources: readonly Ref[] }
export interface RunBasesRequest { readonly project: string; readonly outcomes?: readonly string[] }
/**
 * Admission of the writes of one build: guards the caller read its decision on, the attempts it lets stay open, and
 * whether the bases only complete an accepted frame group (its D2 and G7) rather than admit new work (№1860 п.5, п.8).
 */
export interface RunBasesOptions { readonly guards?: readonly TransactionGuard[]; readonly open?: readonly string[]; readonly completion?: boolean }
/**
 * The stages whose new heads change the area open work stands on (B1, G2, D1, D5/M6, C1); the rest of a build is the
 * common B3 of the same issue, which admits or refuses open work by its own continue/new-work rule.
 */
export const RUN_BASES_HEAD_STAGES = sealed(["input", "run", "horizon", "gaps", "routes", "queue"] as const);
export interface BuiltRunBases { readonly input: Ref; readonly run: Ref; readonly outcomes: readonly string[]; readonly bases: RunBases }
export type CheckedRunBases = { readonly state: "ready"; readonly built: BuiltRunBases } | { readonly state: "missing"; readonly stage: string };

const UNIT = "H1.1";
const object = (value: unknown): value is Record<string, unknown> => isPlainObject(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
class BasesFailure extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
class BasesMissing extends Error { constructor(readonly stage: string) { super(stage); } }
class BasesConflict extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
function take<T>(result: OmResult<T>): T { if (!result.ok) throw new BasesFailure(result.refusal); return result.value; }
function fail(code: string, target: string, field: string, message: string, ref?: Ref): never {
  return take(refused(code, message, { unit: UNIT, target, field, ...(ref ? { ref } : {}) }, "producer"));
}
/**
 * The machine's own choice refused by the common G2 or C1 is the producer's problem, never an owner's (№1860 п.9): its
 * code, address and sources stay. Every other refusal keeps its own route — no broad re-addressing.
 */
function machine(refusal: Refusal): never {
  const own = refusal.code.startsWith("horizon_") || refusal.code === "queue_policy_invalid";
  throw new BasesFailure(own ? { ...refusal, route: "producer" } as Refusal : refusal);
}
function run<T>(action: () => T): OmResult<Sealed<T>> {
  try { return delivered(action()); }
  catch (error) { if (error instanceof BasesFailure) return { ok: false, refusal: error.refusal }; throw error; }
}
function invalid(field: string, message: string): never {
  throw new EngineError("run_bases_request_invalid", message, { unit: UNIT, target: "run-bases", field });
}
function requireRequest(store: unknown, request: unknown): asserts request is RunBasesRequest {
  if (!(store instanceof Store)) invalid("store", "The machine bases are built in a store");
  if (!object(request) || !text(request.project) || !Object.keys(request).every(key => key === "project" || key === "outcomes"))
    invalid("request", "The machine bases name their project and, only when a pass is launched, its intended outcomes");
  if (request.outcomes !== undefined && !(Array.isArray(request.outcomes) && request.outcomes.length > 0 && request.outcomes.every(text)))
    invalid("outcomes", "An explicit launch intent names at least one outcome");
}
function requireOptions(options: unknown): asserts options is RunBasesOptions {
  if (!object(options) || !Object.keys(options).every(key => ["guards", "open", "completion"].includes(key))
    || options.completion !== undefined && typeof options.completion !== "boolean"
    || options.guards !== undefined && !(Array.isArray(options.guards) && options.guards.every(guard => object(guard) && text(guard.id)))
    || options.open !== undefined && !(Array.isArray(options.open) && options.open.every(text)))
    invalid("options", "A build is admitted by explicit guards and the exact attempts it lets stay open");
}

interface Admission { readonly blocked: readonly Ref[]; readonly guards: readonly TransactionGuard[] }
/**
 * `pass` is what every write of a build depends on: the non-terminal pass it read, or its absence before the build
 * itself creates it (which is a lawful change of that dependency, never a conflict).
 */
interface Mode { readonly write: boolean; readonly guards: readonly TransactionGuard[]; readonly completion: boolean; readonly admission: Admission;
  readonly pass: { guard: TransactionGuard | null } }
const HEADS = new Set<string>(RUN_BASES_HEAD_STAGES);
/**
 * One product of the chain: nothing to write means the product exists and is currently admitted. A check stops at the
 * first missing product; a build writes it through its own producer's writes and guards, together with the caller's.
 * A new head of the open work's area is refused while an attempt the caller did not name is open, and its write also
 * carries the admission's guards, so no second store can open work between that decision and this write (№1937-3).
 * A lost compare-and-set is not retried here: the whole build is derived again, admission included.
 */
function commit(store: Store, mode: Mode, unit: string, target: string, stage: string,
  prepare: () => { writes: readonly Write[]; guards: readonly TransactionGuard[] }): void {
  const prepared = prepare();
  if (!prepared.writes.length) return;
  if (!mode.write) throw new BasesMissing(stage);
  const heads = HEADS.has(stage), blocked = mode.admission.blocked[0];
  if (heads && blocked) fail("run_bases_work_open", blocked.id, "attempts", "New bases wait until the open attempts finish on their current bases", blocked);
  const written = writeGuarded(store, { unit, target, writes: [...prepared.writes],
    guards: [...prepared.guards, ...mode.guards, ...(mode.pass.guard ? [mode.pass.guard] : []), ...(heads ? mode.admission.guards : [])] });
  if (written.ok) return;
  if (["input_stale", "revision_conflict"].includes(written.refusal.code)) throw new BasesConflict(written.refusal);
  take(written);
}

/**
 * A pass that ended (complete or unable) takes no new bases (№1995 п.1): the saved pass is read before any product of the
 * chain is derived. An explicit launch intent that differs from the saved one is still the intent conflict of startRun,
 * whatever the phase. A pass that has not ended is returned as read, so a build depends on exactly that record.
 */
function livePass(store: Store, project: string, outcomes: readonly string[] | undefined): Revision<RunRecord> | null {
  const saved = take(readRun(store, { project })) as Revision<RunRecord> | null;
  if (!saved) return null;
  const phase = saved.value.state.phase;
  if (phase !== "complete" && phase !== "unable") return saved;
  if (outcomes !== undefined) take(startRun(store, { project, outcomes: [...outcomes] }));
  return fail("run_bases_terminal", saved.id, "state.phase", `The pass of this project ended (${phase}); no bases are built for it`, reference(saved));
}

/** B1 over today's accepted stages through the common G1: existing, refreshed or first — never a rebuilt "clean" input. */
function inputStage(store: Store, project: string, mode: Mode): Revision<OmInputRecord> {
  const stages = {} as Record<UpstreamStage, Ref>;
  for (const stage of UPSTREAM_STAGES) {
    const head = store.get(`stage:${project}:${stage}`);
    if (!head) fail("record_missing", `stage:${project}:${stage}`, "stages", "The machine bases need every upstream stage of the project");
    stages[stage] = reference(head);
  }
  const inventory = store.get(`repo-inventory:${project}`);
  const request = () => ({ project, stages, inventory: inventory ? reference(inventory) : null,
    expected: store.get(`om-input:${project}`)?.revision ?? 0 });
  commit(store, mode, "G1", `om-input:${project}`, "input", () => take(prepareOmInput(store, request())));
  return store.get<OmInputRecord>(`om-input:${project}`)!;
}
/** The pass of this project and its launch intent: an existing pass keeps its intent; a first one fixes it (№1852). */
function runStage(store: Store, project: string, outcomes: readonly string[] | undefined, mode: Mode): Revision<RunRecord> {
  const saved = take(readRun(store, { project })) as Revision<RunRecord> | null;
  if (saved && outcomes === undefined) return saved;
  if (!saved && !mode.write) throw new BasesMissing("run");
  return take(startRun(store, { project, ...(outcomes === undefined ? {} : { outcomes: [...outcomes] }) })) as Revision<RunRecord>;
}

interface Accepted { graph: Ref; layer: Ref; frame: Ref }
function accepted(store: Store, project: string, level: 2 | 3): Accepted | null {
  const head = store.get(`om-frame:${project}:${level}`);
  if (!head) return null;
  const read = take(readAcceptedFrameLayer(store, { project, level, frame: reference(head) }));
  return { graph: reference(read.graph), layer: reference(read.layer), frame: reference(read.frame) };
}
function layerHead(store: Store, project: string, level: number): Ref | null {
  const head = store.get(`graph-layer:${project}:${level}`);
  return head ? reference(head) : null;
}
/**
 * The representation of the upper layer the horizon and D1 stand on (№1844 п.6, №1860 п.2): an accepted OM N2 frame
 * with its exact graph and layer; otherwise an existing research L2 phase (its own gates admit it or refuse G2);
 * otherwise no refinement. A candidate or assembly is never taken for an accepted layer.
 */
function upperBasis(store: Store, project: string) {
  const n2 = accepted(store, project, 2), n3 = n2 ? accepted(store, project, 3) : null;
  const phase = n2 ? null : store.get(`phase:${project}:L2`);
  const head = store.get(`graph:${project}`);
  if (!head) fail("record_missing", `graph:${project}`, "graph", "The machine bases need the current graph of the project");
  // Every accepted layer lives in the current graph: an accepted N2 or N3 moves the head, and new heads are new bases
  // of the same intent (№1844 п.7); the accepted frames contribute their exact layers and frames.
  const graph = reference(head);
  return { n2, n3, phase: phase ? reference(phase) : null, horizonGraph: graph, gapsGraph: graph,
    refinement: n2 ? n2.layer : phase ? reference(phase) : null };
}
/**
 * The G2 request of the intent (№1852 п.3): its outcomes as the common features, nothing excluded, closure by M2/G2.
 * The issue version is the policy version and the whole normalized request, hashed in full (№1860 п.1): equal exact
 * bases give the same issue, new bases a new issue of the same intent — never a counter or a time.
 */
function horizonRequest(project: string, input: Ref, outcomes: readonly string[], basis: ReturnType<typeof upperBasis>): HorizonRequest {
  const features = [...new Set(outcomes)].sort(order).map(outcome => ({ outcome }));
  const normalizedRequest = { project, input, graph: basis.horizonGraph, refinement: basis.refinement, available: {},
    choice: { features, excluded: [] } };
  const choiceVersion = hashJson({ policyVersion: RUN_BASES_POLICY, normalizedRequest } as unknown as Json);
  return { ...normalizedRequest, choice: { choiceVersion, features, excluded: [] } };
}
function horizonStage(store: Store, project: string, request: HorizonRequest, mode: Mode): Ref {
  const id = `om-horizon:${project}:${request.choice.choiceVersion}`;
  commit(store, mode, "G2", project, "horizon", () => {
    const prepared = prepareHorizon(store, request);
    if (!prepared.ok) machine(prepared.refusal);
    return prepared.value;
  });
  const gate = store.get<{ state: string; codes: string[] }>(id)!;
  if (gate.value.state !== "accepted") {
    const horizon = store.get<{ result: { refusals: Refusal[] } }>(`horizon:${project}:${request.choice.choiceVersion}`)!;
    const first = horizon.value.result.refusals[0];
    machine(first ? { ...first, at: { ...first.at, ref: reference(gate) } } as Refusal
      : { code: gate.value.codes[0] ?? "horizon_unclosed", message: "The common G2 refused the horizon of this intent",
        at: { unit: "G2", target: id, field: "choice", ref: reference(gate) }, route: "producer" } as Refusal);
  }
  return reference(gate);
}
/** One consistent D1 request from the same input, graph and horizon (№1844 п.8, №1860 п.2). */
function gapRequest(store: Store, project: string, input: Ref, horizon: Ref, basis: ReturnType<typeof upperBasis>): { request: GapRequest; guards: TransactionGuard[] } {
  const graph = basis.gapsGraph, frame = (level: 2 | 3, layer: Ref | null, accepted: Ref | null, upper: { horizon: Ref; frame: Ref | null } | null) =>
    ({ project, level, graph, horizon, layer, frame: accepted, upper });
  if (basis.n2) {
    const works = basis.n3 ? frame(3, basis.n3.layer, basis.n3.frame, { horizon, frame: basis.n2.frame })
      : frame(3, null, null, { horizon, frame: basis.n2.frame });
    return { guards: [], request: { project, input, graph, horizon, operations: { frame: frame(2, basis.n2.layer, basis.n2.frame, null), proposals: [] },
      works: { frame: works, proposals: [] } } as GapRequest };
  }
  if (basis.phase) {
    const works3 = worksLayer3(store, project, graph);
    return { guards: works3.guards, request: { project, input, graph, horizon,
      operations: { frame: frame(2, layerHead(store, project, 2), null, null), proposals: [] },
      works: { frame: frame(3, works3.layer, works3.frame, { horizon, frame: null }), proposals: [] } } as GapRequest };
  }
  const layer = layerHead(store, project, 2);
  if (!layer) fail("record_missing", `graph-layer:${project}:2`, "works.layer", "The unaccepted upper layer of the works must exist before D1");
  return { guards: [], request: { project, input, graph, horizon, operations: { frame: frame(2, null, null, null), proposals: [] },
    works: { state: "upper-not-accepted", layer } } as GapRequest };
}
/**
 * The level-3 slot of the research-phase branch (№2157): an existing graph-layer:3 head is accepted only as proven —
 * the full common acceptance derivation and the current admission (prepareLayerAcceptance; an own derivation proof is
 * lawful before sealLayer(3)), a shell with only inherited upper proofs is confirmed unaccepted by the common reader
 * and the level-3 work stays open, and a published L3 phase names its sealed layer — missing, corrupt or moved head
 * is an addressed refusal, never a fallback to open work. The exact read heads and significant absences of the choice
 * are guards of the D1 write, so a competing acceptance between the choice and the write loses the compare-and-set and
 * the whole chain is derived again.
 */
function worksLayer3(store: Store, project: string, graph: Ref): { layer: Ref | null; frame: Ref | null; guards: TransactionGuard[] } {
  const phaseId = `phase:${project}:L3`;
  const phase = store.get<{ layer: Ref | null }>(phaseId);
  const head = store.get<LayerBasis>(`graph-layer:${project}:3`);
  if (phase) {
    const named = phase.value.layer;
    if (!named || !head || !same(named, reference(head)))
      fail("run_bases_basis_stale", phaseId, "layer", "The accepted L3 phase does not name the current level-3 layer head");
    const proven = take(prepareLayerAcceptance(store, { project, level: 3, graph, layer: named }));
    return { layer: named, frame: proven.frame, guards: [...proven.guards, reference(phase)] };
  }
  if (!head) return { layer: null, frame: null, guards: [{ id: `graph-layer:${project}:3`, absent: true }, { id: phaseId, absent: true }] };
  if (head.value.acceptance !== undefined || (head.value.layerProofs ?? []).some(proof => proof.level >= 3)) {
    const proven = take(prepareLayerAcceptance(store, { project, level: 3, graph, layer: reference(head) }));
    return { layer: reference(head), frame: proven.frame, guards: [...proven.guards] };
  }
  const unaccepted = take(readUnacceptedLayer(store, { project, level: 3, graph, layer: reference(head) }));
  return { layer: null, frame: null, guards: [...unaccepted.currentReferences, { id: phaseId, absent: true }] };
}
/**
 * The requirements of a fact task (№1860 п.3): only the exact contracts of B1 bound to the question's own consumer —
 * its node or one of the blocks D1 resolved for it. Nothing else of B1, never the question itself or a first contract.
 */
function requirements(input: OmInputRecord, target: string, consumers: readonly string[]): { pointer: string }[] {
  const question = input.input.questions.find(row => row.id === target);
  const bound = new Set([...(question ? [question.consumer] : []), ...consumers]);
  return input.input.contracts.flatMap((contract, index) => contract.nodes && contract.nodes.some(node => bound.has(node))
    ? [{ pointer: `/contracts/${index}` }] : []).sort((a, b) => order(a.pointer, b.pointer));
}
const routesRequestOf = (record: RoutesRecord, previous: Ref | null): RoutesRequest => ({ project: record.project, gaps: record.request.gaps,
  tasks: record.request.tasks.map(task => ({ record: task })) as RoutesRequest["tasks"],
  catalog: { paths: [...record.request.catalog.paths], records: [...record.request.catalog.records] }, previous });
/**
 * M6 over D1 and its fact tasks, then the explicit successor M6 requires when an accepted answer changed a saved route
 * (route_stale). The catalog is empty: the accepted stages declare no reading paths, and M6 itself adds each gap's own
 * evidence addresses; an address never proves anything (№1844 п.10).
 */
function routesStage(store: Store, project: string, input: Revision<OmInputRecord>, scope: GapReadRequest, mode: Mode): Ref {
  const records = scope.records.map(ref => store.get<{ gap: { kind: string; code: string; deferral?: unknown; target: string; consumers: string[] } }>(ref.id, ref.revision)!);
  const needed = records.filter(row => row.value.gap.kind === "repository-fact" && row.value.gap.code !== "inventory_missing" && !row.value.gap.deferral);
  const questions = needed.map(row => ({ gap: reference(row), requirements: requirements(input.value, row.value.gap.target, row.value.gap.consumers),
    resultForm: FACT_RESULT_FORM as unknown as Json }));
  const tasks = questions.length ? take(prepareQuestionTasks(store, { project, gaps: scope, questions })).tasks : [];
  const base: RoutesRequest = { project, gaps: scope, catalog: { paths: [], records: [] }, previous: null,
    tasks: tasks.map(task => task.writes.length ? { pending: task.writes[0]! } : { record: reference(task.record) }) as RoutesRequest["tasks"] };
  let request = base, at: Ref | null = null;
  for (;;) {
    const current = request;
    let stale: string | null = null, id = "";
    commit(store, mode, "M6", project, "routes", () => {
      const prepared = prepareRoutes(store, current);
      if (!prepared.ok) {
        if (prepared.refusal.code !== "route_stale") take(prepared);
        stale = prepared.refusal.at.target; return { writes: [], guards: [] };
      }
      id = prepared.value.record.id; return prepared.value;
    });
    if (stale === null) { at = reference(store.get(id)!); break; }
    const old = take(readRoutes(store, { project, record: reference(store.get(stale)!) })).record as unknown as Revision<RoutesRecord>;
    request = routesRequestOf(old.value, reference(old));
  }
  return at;
}
function queueStage(store: Store, project: string, horizon: Ref, mode: Mode): Ref {
  const path = prepareMachinePath(store, { project, horizon });
  if (!path.ok) machine(path.refusal);
  const request: QueueRequest = { project, horizon, policy: { version: QUEUE_POLICY_VERSION, machinePath: path.value }, override: null };
  let id = "";
  commit(store, mode, "M3", project, "queue", () => {
    const prepared = prepareBlockQueue(store, request);
    if (!prepared.ok) machine(prepared.refusal);
    id = prepared.value.record.id; return prepared.value;
  });
  return reference(store.get(id)!);
}
/**
 * Series participation (№1844 п.12, №1860 п.8). A legacy project stays legacy: nothing is migrated. A managed one works
 * only on an activation of this very horizon issue: when the current pointer's prepared transition names another
 * issue, or a registered root is still unactivated, the common B3 chain runs for the issue of the intent — P over the
 * complete registered membership, its G2 issuance and the activation — each written by its own producer. An unfinished
 * suitable pair is continued (their addresses are deterministic); a changed issue or membership is a new P.
 */
function managedStage(store: Store, project: string, horizon: Ref, choiceVersion: string, mode: Mode): void {
  // No membership record is the lawful legacy era until a first activation; it is never migrated here.
  const head = store.get(`om-series-membership:${project}`);
  if (!head) return;
  const membership = take(readSeriesMembership(store, { project, record: reference(head) }));
  if (membership.value.mode === "legacy") return;
  const heads = store.list<AnyRepairSeries>("repair-series").filter(row => row.id.startsWith(`repair-series:${project}:`) && "block" in row.value);
  const roots = heads.filter(row => !heads.some(other => other.value.predecessor?.id === row.id))
    .map(row => take(readAnySeriesAt(store, project, reference(row))) as unknown as Revision<RepairSeries>);
  const pointer = take(readCurrentSeriesPointer(store, { project }));
  const applied = take(readAppliedSeriesTransition(store, { project, record: pointer.value.applied }));
  const prepared = take(readPreparedSeriesTransition(store, { project, record: applied.value.prepared }));
  const unactivated = roots.some(series => series.value.activation?.state === "unactivated");
  if (same(prepared.record.value.request.horizon, horizon) && !unactivated) return;
  // The current activation is not this issue's: a check already knows a B3 write is due and prepares nothing more.
  if (!mode.write) throw new BasesMissing("transition");
  const request = { project, choiceVersion, horizon, series: roots.map(series => reference(series)).sort((a, b) => order(a.id, b.id)) };
  let transition: Ref | null = null;
  commit(store, mode, "B3", project, "transition", () => {
    const next = take(prepareSeriesTransition(store, request));
    transition = reference(next.record); return next;
  });
  let issuance: Ref | null = null;
  commit(store, mode, "G2", project, "issuance", () => {
    const next = take(prepareHorizonIssuance(store, { project, choiceVersion, horizon, transition: transition! }));
    issuance = reference(next.record); return next;
  });
  commit(store, mode, "B3", project, "activation", () => take(prepareSeriesActivation(store, { project, prepared: transition!, issuance: issuance! })));
}
/**
 * The admission of new heads (№1860 п.5, №1937-3): every open attempt the caller did not name blocks them. Its guards are
 * the heads of every series read, the absence of the next line of every owner (a root of each L1 block and of M5, or the
 * successor of each current line) and the membership and pointer heads — so work opened or a participant registered by
 * a second store between this reading and a write makes that write fail.
 */
function admissionOf(store: Store, project: string, open: readonly string[]): Admission {
  const heads = store.list<AnyRepairSeries>("repair-series").filter(row => row.id.startsWith(`repair-series:${project}:`));
  const read = heads.map(head => take(readAnySeriesAt(store, project, reference(head))));
  const blocked = read.filter(series => series.value.attempts.some(attempt => attempt.outcome === null) && !open.includes(series.id))
    .map(series => reference(series));
  return { blocked: blocked.sort((a, b) => order(a.id, b.id)), guards: standingOf(store, project, read) };
}
/** What the standing guards need of a series: its address, its owner and its line. */
interface LineRow { readonly id: string; readonly revision: number; readonly hash: string;
  readonly value: { readonly line: number; readonly block?: string; readonly owner?: unknown } }
/**
 * The heads of the series read, the absence of the next line of every owner (a root of each L1 block and of M5, or the
 * successor of each current line), and the membership and pointer heads (№1937-3).
 */
function standingOf(store: Store, project: string, rows: readonly LineRow[]): TransactionGuard[] {
  const guards: TransactionGuard[] = [], lines = new Map<string, { owner: Record<string, unknown>; line: number }>();
  const keyOf = (owner: Record<string, unknown>) => canonical(owner);
  const graph = store.get<{ nodes: { id: string; kind: string }[] }>(`graph:${project}`);
  for (const block of graph?.value.nodes.filter(node => node.kind === "block").map(node => node.id) ?? [])
    lines.set(keyOf({ block }), { owner: { block }, line: 0 });
  lines.set(keyOf({ owner: M5_OWNER }), { owner: { owner: M5_OWNER }, line: 0 });
  for (const row of rows) {
    guards.push({ id: row.id, revision: row.revision, hash: row.hash });
    const owner = row.value.block !== undefined ? { block: row.value.block } : { owner: row.value.owner as Json };
    const known = lines.get(keyOf(owner));
    if (!known || known.line < row.value.line) lines.set(keyOf(owner), { owner, line: row.value.line });
  }
  for (const { owner, line } of lines.values())
    guards.push({ id: seriesAddress({ project, ...owner, line: line + 1 } as never).id, absent: true });
  for (const id of [`om-series-membership:${project}`, `om-series-current:${project}`]) {
    const head = store.get(id);
    guards.push(head ? reference(head) : { id, absent: true });
  }
  return guards;
}
/**
 * The standing heads a decision that no lawful work is left stands on, to be taken at the START of the choice, before
 * the reading they protect (№1995 п.3): every series of the project, the absence of the next line of every owner, the
 * membership and the pointer. It verifies nothing; the choice's own readers do.
 */
export function readRunStandingGuards(store: Store, project: string): OmResult<Sealed<TransactionGuard[]>> {
  requireRequest(store, { project });
  return run(() => standingOf(store, project, store.list<AnyRepairSeries>("repair-series").filter(row => row.id.startsWith(`repair-series:${project}:`))));
}
const M5_OWNER = sealed({ kind: "mechanism", mechanism: "M5:addressing" });
function chain(store: Store, request: RunBasesRequest, mode: Mode): BuiltRunBases {
  const project = request.project;
  const input = inputStage(store, project, mode);
  const pass = runStage(store, project, request.outcomes, mode);
  mode.pass.guard = reference(pass);
  const outcomes = pass.value.intent.outcomes;
  const basis = upperBasis(store, project);
  const issue = horizonRequest(project, reference(input), outcomes, basis);
  const horizon = horizonStage(store, project, issue, mode);
  const d1 = gapRequest(store, project, reference(input), horizon, basis);
  let scope: GapReadRequest | null = null;
  commit(store, mode, "G4", project, "gaps", () => {
    const prepared = take(prepareGaps(store, d1.request));
    const written = prepared.writes.map(write => ({ id: write.id, revision: write.expected + 1, hash: hashJson(write.value) }));
    scope = { sources: prepared.sources as GapRequest, records: [...prepared.existing.map(reference), ...written]
      .sort((a, b) => order(a.id, b.id)) };
    return { ...prepared, guards: [...prepared.guards, ...d1.guards] };
  });
  const routes = routesStage(store, project, input, scope!, mode);
  const queue = queueStage(store, project, horizon, mode);
  // Bases that only complete an accepted group admit no new work: its B3 comes after the group's own D2 and G7 (№1860 п.5, п.8).
  if (!mode.completion) managedStage(store, project, horizon, issue.choice.choiceVersion, mode);
  return { input: reference(input), run: reference(pass), outcomes, bases: { horizon, queue, routes, sources: [] } };
}

/**
 * Builds or finds the bases of the project's pass: B1, the pass with its launch intent (on the first call, the named
 * outcomes or every outcome of B1), then the horizon, D1, D5, M6 and C1 of that intent. Equal exact sources give the
 * same products and no write; an interrupted build is completed by the next call. It refuses while an attempt not
 * named in `open` is still open, so no attempt loses the heads it works on.
 */
export function writeRunBases(store: Store, request: RunBasesRequest, options: RunBasesOptions = {}): OmResult<Sealed<BuiltRunBases>> {
  requireRequest(store, request); requireOptions(options);
  request = sealed(request) as RunBasesRequest; options = sealed(options) as RunBasesOptions;
  const open = options.open ?? [], completion = options.completion ?? false, guards = [...(options.guards ?? [])];
  return run(() => {
    // A lost compare-and-set derives the whole build again, its admission first: an equal concurrent build is then found
    // as it is, and work opened meanwhile blocks the heads it would move. The second loss is the answer.
    for (let attempt = 0; ; attempt++) {
      // The pass is read first: a terminal one refuses here, and every write of the build depends on the record read.
      const pass = livePass(store, request.project, request.outcomes);
      const mode: Mode = { write: true, guards, completion, admission: admissionOf(store, request.project, open),
        pass: { guard: pass ? reference(pass) : { id: runId(request.project), absent: true } } };
      try { return chain(store, request, mode); }
      catch (error) {
        if (!(error instanceof BasesConflict)) throw error;
        if (attempt > 0) throw new BasesFailure(error.refusal);
      }
    }
  });
}
/**
 * The same chain without any write: `ready` with the exact current bases when every product exists and is admitted
 * today, or the first `missing` stage a build would write. `completion` checks only the bases that complete an accepted
 * group, without its B3. An existing pass is required; its intent is never changed.
 */
export function prepareRunBases(store: Store, request: { project: string }, options: { completion?: boolean } = {}): OmResult<Sealed<CheckedRunBases>> {
  requireRequest(store, request);
  if (request.outcomes !== undefined) invalid("outcomes", "Checking the bases never names a new intent");
  if (!object(options) || !Object.keys(options).every(key => key === "completion") || options.completion !== undefined && typeof options.completion !== "boolean")
    invalid("options", "A check names only whether it completes an accepted group");
  request = sealed(request) as RunBasesRequest;
  const mode: Mode = { write: false, guards: [], completion: options.completion ?? false, admission: { blocked: [], guards: [] },
    pass: { guard: null } };
  return run(() => {
    livePass(store, request.project, undefined);
    try { return { state: "ready" as const, built: chain(store, request, mode) }; }
    catch (error) { if (error instanceof BasesMissing) return { state: "missing" as const, stage: error.stage }; throw error; }
  });
}

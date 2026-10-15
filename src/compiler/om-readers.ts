import type { Json } from "../canonical.js";
import { EngineError } from "../errors.js";
import type { CodeRef, Graph } from "../graph/model.js";
import type { Ref } from "../pipeline/contracts.js";
import type { Revision, Store, TransactionGuard } from "../storage/store.js";

/**
 * R3+R4 (№2484): the OM readers the compiler, its context, refinement and task obligations consume, as one lower kit.
 * The real readers stay in their OM modules; om/compiler-readers installs them, and the product assembly point
 * (product/engine) loads that registrant — this module never loads it, nor imports anything of OM, the product or the
 * compiler's own implementations, not even a type. Requests are the readers' exact shapes; results are the read-only
 * slices their consumers take or pass on. The installation is checked by tsc against the real readers.
 */

// ---- Requests: the exact shapes the real readers take.
export interface RecordReadRequest { project: string; record: Ref }
export interface NeighborReadRequest { project: string; neighbors: Ref }
export interface AcceptedFrameRequest { project: string; level: 2 | 3; graph: Ref; layer: Ref; frame: Ref }
export interface CandidateReadRequest { project: string; candidate: Ref }
export interface FrameRequest {
  project: string; level: 2 | 3; horizon: Ref; graph: Ref; layer: Ref | null; frame: Ref | null;
  upper: { horizon: Ref; frame: Ref | null } | null;
  workZoneContract?: "accepted-l2-v1";
}
export interface DeliveryOwnershipBasis { contract: "delivery-ownership/v1"; root: Ref | null; indexes: Record<string, Ref> }
export interface DeliveryReadRequest extends CandidateReadRequest { ownership: DeliveryOwnershipBasis }
export interface FrameObligation {
  id: string; level: 2 | 3; kind: "block-outcome" | "operation-outcome" | "connection-end";
  upper: { node: string; port?: string }; artifact: string; zone: "horizon" | "outside";
  connector?: string; role?: "producer" | "consumer"; flow?: string;
}
export interface NeighborFill {
  obligation: string; node: string; port?: string; codeRef?: CodeRef; source: "accepted" | "identity" | "proposed";
}
export interface NeighborFrame { obligations: FrameObligation[]; fills: NeighborFill[] | null }
export interface NeighborSources {
  identity: string[]; receipts: Record<string, Ref>;
  frames: { operations: NeighborFrame; works: NeighborFrame };
}

/**
 * The obligation handoff an M8 basis carries on to graph/task-obligations: an exact copy of the form those consumers take
 * (graph/obligation-handoff's ObligationHandoff with its parts from graph/om-obligation-readers), which this slot cannot
 * import because those modules reach OM's refusal types. Both directions are checked by tsc: the installation checks the
 * real reader's handoff against this form, and each consumer passes the form where ObligationHandoff is required.
 */
export interface ObligationRuntimeCheck {
  script: Ref; dependencies: Ref[]; subjects: string[]; executables: string[]; args: string[]; timeoutMs: number; purpose: string;
  satisfies?: string;
}
export interface HandoffObligation {
  obligation: string; original: { record: Ref; pointer: string };
  kind: "repository-fact" | "design-decision" | "owner-decision" | "environment-confirmation" | "post-implementation-proof";
  moment: "R2" | "R3" | "task-start" | "task-result";
  responsibleNode: string; responsibleConsumer: string; neededForR2: boolean; reason: string; returnCondition: string | null;
  documentaryAllowance?: { sources: Ref[]; claimLimit: string }; runtimeCheck?: ObligationRuntimeCheck;
  scope: Ref; wake: { nodes: string[]; paths: string[]; uiRequired: boolean } | null;
}
export type ObligationHandoffForm = { r2: Ref; scope: Ref; obligations: HandoffObligation[] }
  | { era: "om-obligations/v1"; producer: Ref; scope: Ref; obligations: HandoffObligation[] };

// ---- Results: what the consumers take, read-only, plus everything they pass on into a context.
export type OmReaderRefusal = {
  readonly code: string; readonly message: string;
  readonly at: { readonly unit: string; readonly target: string; readonly field?: string | undefined; readonly ref?: Ref | undefined };
};
export type OmReaderResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: OmReaderRefusal };
export type OmRecord<T> = Readonly<Omit<Revision<T>, "value">> & { readonly value: T };
/** The deep read-only form an OM reader hands out (the same shape as OM's own sealed values). */
export type Frozen<T> =
  T extends (...args: never[]) => unknown ? never
  : T extends readonly (infer Item)[] ? readonly Frozen<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Frozen<T[Key]> }
  : T;
export interface OmFeasibilityView {
  readonly ready: boolean; readonly graph: Ref; readonly environment: Ref; readonly inputs: readonly Ref[];
  readonly obligations: { readonly handoff: Frozen<ObligationHandoffForm> };
  readonly producer: {
    readonly candidate: Ref; readonly layer: Ref; readonly frame: Ref; readonly horizon: Ref;
    readonly deliveries: {
      readonly ownership: { readonly root: Ref | null; readonly indexes: { readonly [path: string]: Ref } } | null;
      readonly resolved: readonly { readonly producer: string; readonly artifact: string; readonly source: Ref | null; readonly receipt: Ref | null }[];
    };
  };
}
export interface FeasibilityAdmission { readonly passed: true; readonly record: Ref; readonly guards: readonly TransactionGuard[]; readonly references: readonly Ref[] }
export interface AcceptedFrameView {
  readonly frame: OmRecord<{ readonly acceptance: { readonly candidate: Ref;
    readonly gate: { readonly name: "G3"; readonly basis?: never } | { readonly name: "G5"; readonly basis: Ref } } }> | null;
}
export interface AtomicGateView { readonly request: { readonly candidate: Ref; readonly neighbors: Ref;
  readonly taskContextContract?: "omg-task-context/v2" | "omg-task-context/v3" } }
export type TaskContextBasis = { contract: "omg-task-context/v1"; gate: Ref }
  | { contract: "omg-task-context/v2" | "omg-task-context/v3"; gate: Ref; horizon: Ref; input: Ref };
export interface SpecificationBases {
  catalogue: { contract: 'discovery-basis-catalogue/v1'; source: Ref;
    constraints: { address: { record: Ref; pointer: string }; value: Json }[];
    variant: { address: { record: Ref; pointer: string }; value: Json } };
  selected: { owner: { record: Ref; pointer: string };
    bases: { address: { record: Ref; pointer: string }; value: Json }[] }[];
}
interface TaskSpecificationContent {
  contracts: { source: Ref; index: number; pointer: string; value: Json;
    effective: { source: Ref; pointer: string; value: Json } }[];
  preparations: { source: Ref; index: number; pointer: string; featureIndex: number; value: Json }[];
  constraints: { source: Ref; pointer: string; value: Json };
}
export type TaskSpecification = TaskSpecificationContent & ({ contract: 'selected-specification/v1' }
  | { contract: 'selected-specification/v2'; bases: SpecificationBases });
export interface TaskSpecificationRequest { project: string; input: Ref; requirements: string[]; nodes: string[];
  contract?: 'selected-specification/v1' | 'selected-specification/v2' }
/** Narrow selection input shared with the pure task selector in OM. */
export interface TaskSpecificationSelection {
  project: string; inputRef: Ref; contract?: 'selected-specification/v1' | 'selected-specification/v2';
  input: { sources: (Ref & { stage: string; contractVersion?: number | null })[];
    contracts: { id: string; nodes: string[] | null; requirements: string[] }[];
    features: { index: number; title: string; outcome: string; requirementIds: string[]; contracts: string[] }[] };
  accepted: { stage: string; ref: Ref; fields: Record<string, Json> }[];
  requirements: string[]; nodes: string[];
}
export type TaskSpecificationSelector = (request: TaskSpecificationSelection) => TaskSpecification;
export interface NeighborNode { id: string; title: string; outcome: string; represented?: true }
export interface NeighborChain { work: NeighborNode; operation: NeighborNode; block: NeighborNode }
export interface DataNeighbor {
  control?: never; connector: string; artifact: string; contract: { id: string; hash: string; external: boolean };
  direction: "reads" | "writes"; port: string; codeRef: CodeRef | null;
  neighbor: NeighborChain & { port: string; codeRef: CodeRef | null };
  returnsTo: string; delivery: "in-plan" | "available" | "external" | "sleeping" | "undelivered";
  anchor?: string; wakeTest?: string; basis?: Ref;
}
interface ControlNeighbor {
  control: string; connector?: never; port?: never; codeRef?: never; returnsTo?: never; anchor?: never; wakeTest?: never;
  neighbor: NeighborChain & { port?: never; codeRef?: never };
  delivery: DataNeighbor["delivery"]; basis?: Ref;
}
export interface RequiresNeighbor extends ControlNeighbor {
  direction: "requires"; artifact: string; contract: DataNeighbor["contract"]; path?: never; condition?: never;
}
export interface OwnershipNeighbor extends ControlNeighbor {
  direction: "receives" | "sends"; path: string; condition: "producer_committed"; artifact?: never; contract?: never;
}
export type Neighbor = DataNeighbor | RequiresNeighbor | OwnershipNeighbor;
export interface NeighborPacket { work: string; neighbors: Neighbor[]; hash: string }
export interface NeighborCollection { contract: "neighbor-packets/v1"; project: string; source: DeliveryReadRequest; packets: NeighborPacket[] }
export interface WorksFrameView {
  readonly graph: Frozen<Graph>; readonly fills: readonly Readonly<NeighborFill>[];
  readonly request: { readonly frame: Readonly<FrameRequest> };
}
export interface FrameReadView {
  readonly upperRef: Ref; readonly references: readonly Ref[];
  readonly accepted: { readonly frame: { readonly value: { readonly fills: readonly Readonly<NeighborFill>[] } } | null } | null;
  readonly result: { readonly obligations: readonly Readonly<FrameObligation>[] };
}
export interface DeliveryView {
  readonly receipts: { readonly [key: string]: Ref };
  readonly findings: readonly { readonly code: string; readonly target: string; readonly message: string }[];
  readonly references: readonly Ref[];
}

/** The kit, as function-valued properties so tsc checks each real reader strictly when it is installed. */
export interface CompilerOmReaders {
  readonly readTaskContextBasis: (store: Store, request: RecordReadRequest) => OmReaderResult<Frozen<TaskContextBasis>>;
  readonly readTaskSpecification: (store: Store, request: TaskSpecificationRequest) => OmReaderResult<Frozen<TaskSpecification>>;
  readonly readFeasibility: (store: Store, request: RecordReadRequest) => OmReaderResult<OmRecord<OmFeasibilityView>>;
  readonly gateFeasibility: (store: Store, request: RecordReadRequest) => OmReaderResult<FeasibilityAdmission>;
  readonly neighborsOf: (graph: Graph, work: string, sources: NeighborSources) => OmReaderResult<Frozen<NeighborPacket>>;
  readonly readNeighbors: (store: Store, request: NeighborReadRequest) => OmReaderResult<Frozen<Revision<NeighborCollection>>>;
  readonly readAtomicGate: (store: Store, request: RecordReadRequest) => OmReaderResult<OmRecord<AtomicGateView>>;
  readonly readAcceptedFrame: (store: Store, request: AcceptedFrameRequest) => OmReaderResult<AcceptedFrameView>;
  readonly readFrame: (store: Store, request: FrameRequest) => OmReaderResult<FrameReadView>;
  readonly readDeliveries: (store: Store, request: DeliveryReadRequest) => OmReaderResult<DeliveryView>;
  readonly readWorksFrame: (store: Store, request: CandidateReadRequest) => OmReaderResult<OmRecord<WorksFrameView>>;
}
const READERS = Object.freeze(["readFeasibility", "gateFeasibility", "neighborsOf", "readNeighbors", "readAtomicGate",
  "readAcceptedFrame", "readFrame", "readDeliveries", "readWorksFrame", "readTaskContextBasis", "readTaskSpecification"] as const);

let installed: CompilerOmReaders | null = null;
/**
 * Installs the kit once and atomically: an incomplete or non-function kit changes nothing; the same functions again change
 * nothing; any other function is a conflict that keeps the installed kit. The slot keeps its own copy of the references,
 * so mutating the registration object afterwards changes nothing. Installing calls no reader.
 */
export function registerCompilerOmReaders(readers: CompilerOmReaders): void {
  const invalid = (target: string) => new EngineError("om_compiler_reader_invalid",
    "The compiler's OM readers must be installed as one complete set of functions", { unit: "compiler", target });
  if (typeof readers !== "object" || readers === null) throw invalid("readers");
  // Each member is read exactly once: the copy is what is checked and installed, so an accessor cannot pass the check
  // with one value and install another.
  const kit: CompilerOmReaders = Object.freeze({ readFeasibility: readers.readFeasibility, gateFeasibility: readers.gateFeasibility,
    neighborsOf: readers.neighborsOf, readNeighbors: readers.readNeighbors, readAtomicGate: readers.readAtomicGate,
    readAcceptedFrame: readers.readAcceptedFrame, readFrame: readers.readFrame, readDeliveries: readers.readDeliveries,
    readWorksFrame: readers.readWorksFrame, readTaskContextBasis: readers.readTaskContextBasis, readTaskSpecification: readers.readTaskSpecification });
  const missing = READERS.find(name => typeof kit[name] !== "function");
  if (missing) throw invalid(missing);
  if (installed) {
    const differs = READERS.find(name => installed![name] !== kit[name]);
    if (differs) throw new EngineError("om_compiler_reader_conflict", "Another OM reader is already installed for the compiler", { unit: "compiler", target: differs });
    return;
  }
  installed = kit;
}
const field = (request: unknown, key: string): unknown =>
  typeof request === "object" && request !== null ? (request as Record<string, unknown>)[key] : undefined;
/** An empty slot is the addressed refusal of the product's assembly, never a null or a successful stand-in. */
function reader<K extends keyof CompilerOmReaders>(name: K, request: unknown, keys: readonly string[]): CompilerOmReaders[K] {
  if (!installed) throw new EngineError("om_compiler_reader_unavailable", "The compiler's OM readers are installed by the product assembly point",
    { unit: "compiler", target: name, ...Object.fromEntries(keys.map(key => [key, field(request, key)])) });
  return installed[name];
}
export const readFeasibility: CompilerOmReaders["readFeasibility"] = (store, request) =>
  reader("readFeasibility", request, ["project", "record"])(store, request);
export const gateFeasibility: CompilerOmReaders["gateFeasibility"] = (store, request) =>
  reader("gateFeasibility", request, ["project", "record"])(store, request);
export const neighborsOf: CompilerOmReaders["neighborsOf"] = (graph, work, sources) =>
  reader("neighborsOf", { work }, ["work"])(graph, work, sources);
export const readNeighbors: CompilerOmReaders["readNeighbors"] = (store, request) =>
  reader("readNeighbors", request, ["project", "neighbors"])(store, request);
export const readAtomicGate: CompilerOmReaders["readAtomicGate"] = (store, request) =>
  reader("readAtomicGate", request, ["project", "record"])(store, request);
export const readAcceptedFrame: CompilerOmReaders["readAcceptedFrame"] = (store, request) =>
  reader("readAcceptedFrame", request, ["project", "level", "frame"])(store, request);
export const readFrame: CompilerOmReaders["readFrame"] = (store, request) =>
  reader("readFrame", request, ["project", "level", "frame"])(store, request);
export const readDeliveries: CompilerOmReaders["readDeliveries"] = (store, request) =>
  reader("readDeliveries", request, ["project", "candidate"])(store, request);
export const readWorksFrame: CompilerOmReaders["readWorksFrame"] = (store, request) =>
  reader("readWorksFrame", request, ["project", "candidate"])(store, request);

export const readTaskContextBasis: CompilerOmReaders["readTaskContextBasis"] = (store, request) =>
  reader("readTaskContextBasis", request, ["project", "record"])(store, request);
export const readTaskSpecification: CompilerOmReaders["readTaskSpecification"] = (store, request) =>
  reader("readTaskSpecification", request, ["project", "input"])(store, request);

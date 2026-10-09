import { EngineError } from '../errors.js';
import { isRef, type Ref } from '../pipeline/contracts.js';
import type { OmResult, Sealed } from '../om/refusal.js';
import { Store, type Revision } from '../storage/store.js';

/** The OM obligation contract constants and shapes that lower layers read.
 * They live below the OM unit so the reader slot never reaches back into the
 * import ring; obligation-policy.ts re-exports them for the policy contract. */
export const KNOWLEDGE_KINDS = ['repository-fact', 'design-decision', 'owner-decision', 'environment-confirmation', 'post-implementation-proof'] as const;
export const RESOLUTION_MOMENTS = ['R2', 'R3', 'task-start', 'task-result'] as const;
export interface RuntimeCheck { script: Ref; dependencies: Ref[]; subjects: string[]; executables: string[]; args: string[]; timeoutMs: number; purpose: string;
  /** Explicit owner contract: exit zero certifies this entire return condition. */
  satisfies?: string }
/** The wake contract of a carried obligation — the same shape a research scope
 * records inline; the lower contract keeps it named so it needs no scope type. */
export type ObligationWake = { nodes: string[]; paths: string[]; uiRequired: boolean } | null;
export interface ObligationAssignment {
  obligation: string;
  original: { record: Ref; pointer: string };
  kind: typeof KNOWLEDGE_KINDS[number];
  moment: typeof RESOLUTION_MOMENTS[number];
  responsibleNode: string; responsibleConsumer: string;
  neededForR2: boolean; reason: string;
  returnCondition: string | null;
  documentaryAllowance?: { sources: Ref[]; claimLimit: string };
  runtimeCheck?: RuntimeCheck;
}
export interface CarriedObligation extends ObligationAssignment { scope: Ref; wake: ObligationWake }
/**
 * OWN1.2 (№3806, №3809): the one admissible consumer proof of an obligation a work binds — its own contract tests for
 * post-implementation knowledge at task result, or the owner's runtime check that certifies the whole return condition
 * of an environment confirmation. Any other kind or deadline has none: no work can bind it.
 */
export function consumerProofOf(obligation: Pick<ObligationAssignment, 'kind' | 'moment' | 'returnCondition' | 'runtimeCheck'>): 'tests' | 'runtime' | null {
  if (obligation.kind === 'post-implementation-proof' && obligation.moment === 'task-result') return 'tests';
  if (obligation.kind === 'environment-confirmation' && obligation.runtimeCheck?.satisfies === obligation.returnCondition) return 'runtime';
  return null;
}

export const OM_OBLIGATION_CONTRACT = 'om-obligations/v1';
/** The immutable OM era handoff: producer and its complete ledger select it. */
export interface OmObligationHandoff {
  era: typeof OM_OBLIGATION_CONTRACT; producer: Ref; scope: Ref; obligations: CarriedObligation[];
}
/** Typed projection of the OM ledger for lower consumers: producer and record
 * are exact revision identities here; their bodies stay with the OM unit. */
export interface OmObligationProducerView {
  contract: typeof OM_OBLIGATION_CONTRACT; project: string; request: unknown; ledger: Ref;
}
export interface OmObligationRecordView {
  contract: typeof OM_OBLIGATION_CONTRACT; project: string; request: unknown; assignments: Omit<CarriedObligation, 'scope'>[];
}
export interface OmObligationLedger {
  producer: Revision<OmObligationProducerView>; record: Revision<OmObligationRecordView>;
  handoff: OmObligationHandoff; inputs: Ref[];
}

export type OmObligationHandoffReader = (store: Store, project: string, inputs: Ref[]) => OmResult<Sealed<OmObligationHandoff | null>>;
export type OmObligationLedgerReader = (store: Store, request: { project: string; ledger: Ref }) => OmResult<Sealed<OmObligationLedger>>;
export interface OmObligationReaders { handoff: OmObligationHandoffReader; ledger: OmObligationLedgerReader }

/** The record-id prefixes that select the OM obligation era in consumer
 * inputs: the producer writes its basis and ledger records under them. The OM
 * unit's own reader uses the same constants, so this lower check and the real
 * read can never disagree about which inputs name the era. */
export const OM_PRODUCER_ID_PREFIX = 'om-obligation-basis:';
export const OM_LEDGER_ID_PREFIX = 'om-obligations:';

/** Whether an obligation-handoff request reaches the OM reader at all. Pure —
 * it reads the request, never the store: the era is selected only by the
 * explicit producer and ledger refs the producer wrote into the consumer's
 * inputs. A malformed request still counts: the registered reader owns its
 * validation refusal, and the empty slot answers for the absent OM unit. */
export function omObligationReadRequired(store: Store, project: string, inputs: readonly Ref[]): boolean {
  if (!(store instanceof Store) || typeof project !== 'string' || !project.trim().length
    || !Array.isArray(inputs) || !inputs.every(isRef)) return true;
  return inputs.some(ref => ref.id.startsWith(OM_PRODUCER_ID_PREFIX) || ref.id.startsWith(OM_LEDGER_ID_PREFIX));
}

const UNIT = 'graph', TARGET = 'om-obligation-readers';
// Registration state, empty by default: a read where the OM unit never loaded
// is refused, never let through on its shape. om/obligations registers its
// complete pair when it loads; the slot calls nothing and reads nothing itself.
let installed: OmObligationReaders | null = null;

export function registerOmObligationReaders(readers: OmObligationReaders): void {
  if (readers === null || typeof readers !== 'object'
    || typeof readers.handoff !== 'function' || typeof readers.ledger !== 'function')
    throw new EngineError('om_obligation_reader_invalid',
      'Both OM obligation readers install together or not at all', { unit: UNIT, target: TARGET, field: 'readers' });
  if (installed !== null) {
    if (installed.handoff === readers.handoff && installed.ledger === readers.ledger) return;
    throw new EngineError('om_obligation_reader_conflict',
      'The OM obligation readers are registered already, and another pair does not replace them',
      { unit: UNIT, target: TARGET, field: 'readers' });
  }
  // The function references are kept, not the caller's object: mutating it
  // afterwards cannot replace what was installed.
  installed = { handoff: readers.handoff, ledger: readers.ledger };
}

export function readOmObligationHandoff(store: Store, project: string, inputs: Ref[]): OmResult<Sealed<OmObligationHandoff | null>> {
  const readers = installed;
  if (readers === null) throw new EngineError('om_obligation_reader_unavailable',
    'The OM obligation handoff reader is not registered in this process; the OM obligations unit must be loaded first',
    { unit: UNIT, target: 'readOmObligationHandoff', project });
  return readers.handoff(store, project, inputs);
}

export function readOmObligationLedger(store: Store, request: { project: string; ledger: Ref }): OmResult<Sealed<OmObligationLedger>> {
  const readers = installed;
  if (readers === null) throw new EngineError('om_obligation_reader_unavailable',
    'The OM obligation ledger reader is not registered in this process; the OM obligations unit must be loaded first',
    { unit: UNIT, target: 'readOmObligationLedger', project: request?.project, ledger: request?.ledger });
  return readers.ledger(store, request);
}

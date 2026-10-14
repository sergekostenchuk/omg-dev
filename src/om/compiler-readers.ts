import { EngineError } from '../errors.js';
import { taskSpecificationReader } from './task-specification.js';
export { taskSpecificationReader } from './task-specification.js';
import { canonical } from '../canonical.js';
import { isRef } from '../pipeline/contracts.js';
import { delivered } from './refusal.js';
import { readHorizon } from './horizon.js';
import { readOmInput } from './input.js';
import { registerCompilerOmReaders, type CompilerOmReaders } from '../compiler/om-readers.js';
import { gateFeasibility, readFeasibility } from './feasibility.js';
import { neighborsOf, readNeighbors } from './neighbors.js';
import { readAtomicGate } from './atomic-gate.js';
import { readAcceptedFrame } from './frame-accept.js';
import { readFrame } from './frame-obligations.js';
import { readDeliveries } from './deliveries.js';
import { readWorksFrame } from './works-frame.js';

function requireContext(condition: unknown, message: string, details: { unit: string; target: string; field: string }): asserts condition {
  if (!condition) throw new EngineError('context_source_invalid', message, details);
}

/** The accepted G5 selects the context era; neither today's stage nor today's environment does. */
export const readTaskContextBasis: CompilerOmReaders['readTaskContextBasis'] = (store, request) => {
  const checked = readFeasibility(store, request); if (!checked.ok) return checked;
  const m8 = checked.value.value, producer = m8.producer;
  const frame = readAcceptedFrame(store, { project: request.project, level: 3, graph: m8.graph,
    layer: producer.layer, frame: producer.frame });
  if (!frame.ok) return frame;
  const acceptance = frame.value.frame?.value.acceptance, gateRef = acceptance?.gate;
  requireContext(acceptance && gateRef?.name === 'G5' && isRef(gateRef.basis)
    && canonical(acceptance.candidate) === canonical(producer.candidate),
  'The plan context needs the G5 of its exact M8 candidate', { unit: 'V2', target: request.record.id, field: 'G5' });
  const gate = readAtomicGate(store, { project: request.project, record: gateRef.basis }); if (!gate.ok) return gate;
  const value = gate.value.value, contract = value.request.taskContextContract;
  requireContext(value.result.passed && canonical(value.request.candidate) === canonical(producer.candidate),
    'The exact G5 admitted the M8 candidate', { unit: 'V2', target: gateRef.basis.id, field: 'candidate' });
  if (!Object.hasOwn(value.request, 'taskContextContract')) return delivered({ contract: 'omg-task-context/v1', gate: gateRef.basis });
  requireContext(contract === 'omg-task-context/v2', 'The saved G5 names a known context contract',
    { unit: 'V2', target: gateRef.basis.id, field: 'taskContextContract' });
  const horizon = readHorizon(store, request.project, producer.horizon); if (!horizon.ok) return horizon;
  const input = horizon.value.horizon.value.request.input;
  requireContext(horizon.value.gate.value.state === 'accepted' && canonical(input) === canonical(value.request.gaps.sources.input)
    && canonical(producer.horizon) === canonical(value.request.gaps.sources.horizon),
  'M8 and G5 bind one accepted horizon and exact input', { unit: 'V2', target: request.record.id, field: 'input' });
  const checkedInput = readOmInput(store, request.project, input); if (!checkedInput.ok) return checkedInput;
  return delivered({ contract, gate: gateRef.basis, horizon: producer.horizon, input });
};

// R3+R4 (№2484): installs the OM readers the compiler, its context, refinement and
// task obligations consume into their lower slot. Loaded by the product assembly
// point (product/engine); the slot itself never loads this module. The assignment
// below is where tsc checks every real reader against the slot's structural types.
registerCompilerOmReaders({
  readFeasibility, gateFeasibility, neighborsOf, readNeighbors, readAtomicGate,
  readAcceptedFrame, readFrame, readDeliveries, readWorksFrame, readTaskContextBasis,
  readTaskSpecification: taskSpecificationReader(),
});

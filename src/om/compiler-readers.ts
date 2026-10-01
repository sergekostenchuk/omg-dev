import { registerCompilerOmReaders } from '../compiler/om-readers.js';
import { gateFeasibility, readFeasibility } from './feasibility.js';
import { neighborsOf, readNeighbors } from './neighbors.js';
import { readAtomicGate } from './atomic-gate.js';
import { readAcceptedFrame } from './frame-accept.js';
import { readFrame } from './frame-obligations.js';
import { readDeliveries } from './deliveries.js';
import { readWorksFrame } from './works-frame.js';

// R3+R4 (№2484): installs the OM readers the compiler, its context, refinement and
// task obligations consume into their lower slot. Loaded by the product assembly
// point (product/engine); the slot itself never loads this module. The assignment
// below is where tsc checks every real reader against the slot's structural types.
registerCompilerOmReaders({
  readFeasibility, gateFeasibility, neighborsOf, readNeighbors, readAtomicGate,
  readAcceptedFrame, readFrame, readDeliveries, readWorksFrame,
});

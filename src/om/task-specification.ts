import { readOmAcceptedMaterial } from './accepted-material.js';
import { acceptedDiscoveryBasisCatalogue } from '../discovery/discovery-handoff.js';
import { canonical, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef } from '../pipeline/contracts.js';
import type { CompilerOmReaders, TaskSpecificationSelector } from '../compiler/om-readers.js';
import { delivered, sealed } from './refusal.js';
import { readOmInput, type OmInput } from './input.js';
import { selectTaskSpecification } from './selected-specification.js';

/** Resolve only immutable, proved B1 sources. The selector is shared by G5 and the saved-plan consumer. */
export function taskSpecificationReader(select: TaskSpecificationSelector = selectTaskSpecification): CompilerOmReaders['readTaskSpecification'] {
  return (store, request) => {
    if (!(request && typeof request.project === 'string' && isRef(request.input)
      && Array.isArray(request.requirements) && request.requirements.every(id => typeof id === 'string' && id.length)
      && (!Object.hasOwn(request, 'contract') || ['selected-specification/v1', 'selected-specification/v2'].includes(request.contract!))
      && Array.isArray(request.nodes) && request.nodes.every(id => typeof id === 'string' && id.length)))
      throw new EngineError('context_source_invalid', 'Task selection needs its exact input, requirements and node ancestry',
        { unit: 'V2', target: request?.input?.id ?? 'task-specification', field: 'request' });
    const read = readOmInput(store, request.project, request.input); if (!read.ok) return read;
    const input = structuredClone(read.value.value.input) as OmInput;
    const material = readOmAcceptedMaterial(store, request.project, request.input);
    return delivered(sealed(select({ project: request.project, inputRef: request.input, input, accepted: material.accepted,
      ...(material.discovery ? { discovery: JSON.parse(canonical(material.discovery)) as Json,
        discoveryCatalogue: acceptedDiscoveryBasisCatalogue(material.discovery) } : {}),
      requirements: request.requirements, nodes: request.nodes, ...(request.contract ? { contract: request.contract } : {}) })));
  };
}


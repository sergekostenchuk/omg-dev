import { EngineError } from '../errors.js';
import { isRef, reference, stageId, type StageArtifact } from '../pipeline/contracts.js';
import type { CompilerOmReaders, TaskSpecificationSelector } from '../compiler/om-readers.js';
import { delivered, sealed } from './refusal.js';
import { readRecord } from './refs.js';
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
    const accepted = [];
    for (const source of input.sources) {
      const row = readRecord<StageArtifact>(store, source, { unit: 'V2', target: request.input.id,
        id: stageId(request.project, source.stage), kind: 'stage' });
      if (!row.ok) return row;
      // readOmInput has proved this exact accepted prefix; do not re-admit it against current heads.
      const content = row.value.value.content as { fields: Record<string, import('../canonical.js').Json> };
      accepted.push({ stage: source.stage, ref: reference(row.value), fields: structuredClone(content.fields) });
    }
    return delivered(sealed(select({ project: request.project, inputRef: request.input, input, accepted,
      requirements: request.requirements, nodes: request.nodes, ...(request.contract ? { contract: request.contract } : {}) })));
  };
}


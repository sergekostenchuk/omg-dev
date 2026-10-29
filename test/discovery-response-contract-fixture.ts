import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import type { Store } from '../src/storage/store.js';
import type { Ref } from '../src/pipeline/contracts.js';
import { readArchiveBody } from '../src/discovery/request-parts.js';
import { contextValue } from '../src/discovery/working-context.js';
import { hashJson } from '../src/canonical.js';

/** Inspect the actual assembled/sent packet, resolving only its exact advertised archive. */
export function deliveredContract(store: Store, wire: any, purpose: string, reply?: unknown) {
  const packet = wire.subject?.working ? wire.subject : wire;
  let result = packet.discoveryResponseContract;
  if (!result) {
    const address = packet.working?.materialAddresses?.find((a: any) => a.field === 'discoveryResponseContract');
    assert.ok(address, `${purpose}: missing response form on wire`);
    const ref = address.record as Ref, row = store.get<any>(ref.id, ref.revision);
    assert.equal(row?.hash, ref.hash);
    result = contextValue({ body: readArchiveBody(store, row!).body }, address.pointer);
    assert.equal(hashJson(result), address.valueHash);
  }
  assert.equal(result.contract, 'discovery-response-contract/v1');
  assert.equal(result.purpose, purpose);
  assert.ok(result.instruction.includes('UTF-16'));
  const validate = new Ajv({ strict: true }).compile(result.schema);
  if (reply !== undefined) assert.ok(validate(reply), `${purpose}: ${JSON.stringify(validate.errors)}`);
  return result;
}

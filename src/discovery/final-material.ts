import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { Ref } from '../pipeline/contracts.js';
import type { ContextWorkspace } from './context-workspace.js';
import { contextWorkspace, pendingContextWorkspace, packContextWorkspace, recordContextPacket } from './context-workspace.js';
import { dossierMaterialProjection } from './dossier-material.js';
import { addressArchivedMaterials, serveArchivedMaterial } from './research-delivery.js';

/** Immutable preparation capability. Markerless preparations retain their original transport. */
export const FINAL_MATERIAL_CONTRACT = 'discovery-final-material/v1' as const;
export type FinalMaterialContract = typeof FINAL_MATERIAL_CONTRACT;
export function finalMaterialEra(value: { materialContract?: unknown }): boolean {
  requireCondition(!Object.hasOwn(value,'materialContract') || value.materialContract === FINAL_MATERIAL_CONTRACT,
    'discovery_final_material_invalid', 'Unknown final material transport era');
  return value.materialContract === FINAL_MATERIAL_CONTRACT;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function finalPacket(packet: any, path: string): any {
  requireCondition(same(packet.dossier, packet.assessment.value.result.packet)
    && same(packet.basis, packet.dossier.basis), 'discovery_final_material_invalid',
    'The final input must retain the exact assessed dossier and basis');
  const dossier = dossierMaterialProjection(packet.dossier);
  // The shared D6 projector owns content classification. Only relocate its exact
  // technical pointers into this preparation's complete original request.
  const records = dossier.records.map(row => 'technical' in row ? {...row,
    technical: {...row.technical, pointer: row.technical.pointer.replace('/body/dossierPacket', `${path}/dossier`)}} : row);
  const basis = packet.subject.basis;
  return {contract:packet.contract, subject:packet.subject,
    dossier:{...dossier,records}, basis:{dossierBasis:true}, brief:packet.brief,
    assessment:{...packet.assessment,value:{...packet.assessment.value,
      result:{...packet.assessment.value.result,packet:{dossierHash:hashJson(packet.dossier)}}}},
    terminal:Object.fromEntries(['session','application','call','request','response'].map(key => [key,{record:basis[key],technicalPointer:`${path}/terminal/${key}`}]))};
}

/** All substantive fields remain present. Duplicate assessed dossiers and
 * physical execution bodies are represented by their engine-proven identities. */
export function finalMaterialProjection(packet: any): Record<string, any> {
  let content: unknown;
  if (packet?.contract === 'discovery-final-packet/v1') content = finalPacket(packet,'/body/request/packet');
  else if (packet?.contract === 'discovery-final-assessment-packet/v1') {
    requireCondition(same(packet.candidate,packet.subject.candidate), 'discovery_final_material_invalid',
      'The assessment must retain its exact candidate');
    content = {...packet,candidate:{subjectCandidate:true},final:finalPacket(packet.final,'/body/request/packet/final')};
  } else {
    requireCondition(packet?.contract === 'discovery-condition-evidence-packet/v1',
      'discovery_final_material_invalid', 'Unknown final material packet');
    content = packet;
  }
  return structuredClone({contract:FINAL_MATERIAL_CONTRACT,packetHash:hashJson(packet),content,
    instruction:'Read all substantive material before the terminal answer. Exact technical records remain in the complete original request in working.archive; their bodies are optional. dossierHash and recordIndex preserve shared content, not omitted evidence.'});
}

export function finalMaterialAdmission(request: Record<string, any>): Record<string, any> {
  return {contract:request.contract,subject:request.subject,schema:request.schema,
    materialContract:FINAL_MATERIAL_CONTRACT,packetHash:hashJson(request.packet),
    materialHash:hashJson(finalMaterialProjection(request.packet))};
}
function finalMaterialDeclaration(request: Record<string, any>, source: Ref): Record<string, any> {
  const admission = finalMaterialAdmission(request);
  return {contract:admission.contract,materialContract:FINAL_MATERIAL_CONTRACT,
    packetHash:admission.packetHash,materialHash:admission.materialHash,
    admission:{record:source,pointer:'/body/admission',hash:hashJson(admission)}};
}
export function finalMaterialArchive(request: Record<string, any>, era: boolean) {
  return era ? {request,finalMaterial:finalMaterialProjection(request.packet),admission:finalMaterialAdmission(request)} : {request};
}
export function finalMaterialPointer(era: boolean) { return era ? '/body/admission' : '/body/request'; }
export function finalWorkspace(input: {materialContract?: unknown}, workspace: ContextWorkspace) {
  return finalMaterialEra(input) ? pendingContextWorkspace(workspace).entries.map(entry => entry.result)
    : workspace.entries.map(entry => entry.result);
}

/** Delivery trims a view of a lookup, never the saved lookup history. Keep
 * only the proved coverage from that view beside the original paid entries. */
export function recordFinalMaterialWorkspace(workspace: ContextWorkspace, packet: Record<string, any>): ContextWorkspace {
  const delivered = recordContextPacket(contextWorkspace(pendingContextWorkspace(workspace)),packet);
  return {...workspace,deliveryCoverage:delivered.deliveryCoverage ?? []};
}

/** Called only with the preparation and historical workspace already proved by
 * the role's common admission reader. Coverage never comes from a wire flag. */
export function packFinalMaterial(packet: Record<string, any>, request: Record<string, any>,
  archive: Ref, source: Ref, limit: number, workspace: ContextWorkspace): void {
  // Subject and schema already have mandatory fields in the physical packet.
  // Pin the complete admission instead of copying both fields a second time.
  packet.subject = structuredClone(request.subject);
  packet.schema = structuredClone(request.schema);
  packet.request = finalMaterialDeclaration(request,source);
  packet.finalMaterial = finalMaterialProjection(request.packet);
  const pending = pendingContextWorkspace(workspace);
  packet.contextWorkspace = pending.entries.map(entry => entry.result);
  const originals = addressArchivedMaterials(packet,archive,['finalMaterial'],limit,() => source,2048,{pageChars:limit});
  packContextWorkspace(packet,limit,limit,undefined,1024);
  const delivered = recordContextPacket(contextWorkspace(pending),packet);
  if (!pending.entries.length) serveArchivedMaterial(packet,originals,limit,512,{coverage:delivered.deliveryCoverage ?? [],pageChars:limit});
}

/** Paid-wire proof: neither dropping the material field nor inventing a smaller
 * required address can turn an incomplete request into a completed review. */
export function requireFinalMaterialDelivery(packet: Record<string, any>, request: Record<string, any>, source: Ref): void {
  const material = finalMaterialProjection(request.packet);
  requireCondition(packet.working?.deliveryContract === 'research-delivery/v1'
    && packet.working?.materialPaging === 'covered-material/v1', 'discovery_final_material_invalid',
    'The physical final request lost its required delivery contract');
  requireCondition(same(packet.request,finalMaterialDeclaration(request,source))
    && same(packet.subject,request.subject) && same(packet.schema,request.schema), 'discovery_final_material_invalid',
    'The physical final request lost its exact compact declaration');
  if (Object.hasOwn(packet,'finalMaterial')) {
    requireCondition(same(packet.finalMaterial,material), 'discovery_final_material_invalid',
      'The physical final request changed its substantive material');
  } else requireCondition(packet.working?.materialAddresses?.some((address: any) =>
    address.field === 'finalMaterial' && same(address.record,source) && address.pointer === '/body/finalMaterial'
    && address.valueHash === hashJson(material) && address.total === canonical(material).length
    && address.encoding === 'canonical-json' && address.unit === 'utf16'),
    'discovery_final_material_invalid', 'The physical final request omitted required substantive material');
}

/** Optional technical bodies are addressable in the full invocation archive.
 * The permitted paths are derived from the same content projector, never supplied by the caller. */
export function finalTechnicalLookup(packet: Record<string, any>, request: Record<string, any>, action: {record: Ref;pointer:string}): boolean {
  if (!same(action.record,packet.working?.archive)) return false;
  const material = finalMaterialProjection(request.packet);
  const final = request.packet.contract === 'discovery-final-packet/v1' ? material.content
    : request.packet.contract === 'discovery-final-assessment-packet/v1' ? material.content.final : null;
  const pointers: string[] = final ? [
    ...final.dossier.records.filter((row: any) => row.technical).map((row: any) => row.technical.pointer),
    ...Object.values(final.terminal).map((row: any) => row.technicalPointer),
  ] : [];
  return pointers.some(pointer => action.pointer === pointer || action.pointer.startsWith(pointer+'/'));
}

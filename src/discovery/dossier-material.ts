import { canonical, hashJson } from '../canonical.js';
import { requireCondition } from '../errors.js';
import type { DossierAssessmentPacket, DossierAssessmentRecord } from './research-model.js';
import type { ContextWorkspace, ContextCoverage } from './context-workspace.js';

/** Saved on the session origin before the first paid application. Absence is the historical full-packet era. */
export const DOSSIER_MATERIAL_CONTRACT = 'dossier-material-dictionary/v1' as const;
export interface DossierPagingState { contract: typeof DOSSIER_MATERIAL_CONTRACT; coverage: ContextCoverage[] }

export function dossierMaterialEra(value: Record<string, unknown>): boolean {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value),
    'discovery_dossier_transport_invalid', 'Dossier transport must be an object');
  if (!Object.hasOwn(value, 'dossierMaterialContract')) {
    requireCondition(!Object.hasOwn(value,'dossierMaterial'), 'discovery_dossier_transport_invalid',
      'A dictionary cannot lose its saved transport era');
    return false;
  }
  requireCondition(value.dossierMaterialContract === DOSSIER_MATERIAL_CONTRACT,
    'discovery_dossier_transport_invalid', 'Unknown dossier material transport era');
  return true;
}

// Only the packet's structural record slots are mapped. Values, classifications,
// unknowns and contradiction descriptions remain opaque, including record-shaped user JSON.
function mapRecords(packet: any, record: (value: any) => any): any {
  const material = (value: any) => ({...value, container:record(value.container),
    assessment:value.assessment === null ? null : record(value.assessment)});
  return {...packet, root:record(packet.root), manifest:record(packet.manifest),
    basis:Object.fromEntries(Object.entries(packet.basis).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key,record(value)])),
    route:Object.fromEntries(Object.entries(packet.route).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key,value === null ? null : record(value)])),
    materials:packet.materials.map(material),
    unknowns:packet.unknowns.map((item: any) => ({...item,material:material(item.material)})),
    contradictions:packet.contradictions.map((item: any) => ({...item,sides:item.sides.map(material),grounds:item.grounds.map(record)})),
    grounds:packet.grounds.map(record)};
}
export interface DossierMaterialDictionary {
  contract: typeof DOSSIER_MATERIAL_CONTRACT;
  packetHash: string;
  records: DossierAssessmentRecord<unknown>[];
  packet: any;
}
export function dossierMaterialDictionary(packet: DossierAssessmentPacket): DossierMaterialDictionary {
  const records:DossierAssessmentRecord<unknown>[] = [], indexes = new Map<string, number>();
  const mapped = mapRecords(packet, (row: DossierAssessmentRecord<unknown>) => {
    const key = canonical(row.ref), prior = indexes.get(key);
    if (prior !== undefined) {
      requireCondition(canonical(records[prior]) === canonical(row), 'discovery_dossier_transport_invalid',
        'One exact dossier record cannot have different bodies');
      return {recordIndex:prior};
    }
    const index = records.length; indexes.set(key,index); records.push(row);
    return {recordIndex:index};
  });
  return structuredClone({contract:DOSSIER_MATERIAL_CONTRACT,packetHash:hashJson(packet as never),records,packet:mapped});
}
export function restoreDossierMaterial(dictionary: DossierMaterialDictionary): DossierAssessmentPacket {
  requireCondition(dictionary?.contract === DOSSIER_MATERIAL_CONTRACT && Array.isArray(dictionary.records),
    'discovery_dossier_transport_invalid', 'The dossier dictionary is missing');
  requireCondition(dictionary.packet && typeof dictionary.packet === 'object' && dictionary.packet.basis && dictionary.packet.route
    && ['materials','unknowns','contradictions','grounds'].every(key => Array.isArray(dictionary.packet[key])),
    'discovery_dossier_transport_invalid', 'The complete dossier structure is missing');
  const packet = mapRecords(dictionary.packet, (link: any) => {
    requireCondition(link && Object.keys(link).join(',') === 'recordIndex' && Number.isSafeInteger(link.recordIndex)
      && link.recordIndex >= 0 && link.recordIndex < dictionary.records.length,
      'discovery_dossier_transport_invalid', 'The dossier record reference is missing');
    return dictionary.records[link.recordIndex];
  });
  requireCondition(hashJson(packet) === dictionary.packetHash
    && canonical(dossierMaterialDictionary(packet)) === canonical(dictionary),
    'discovery_dossier_transport_invalid', 'The dictionary lost exact dossier content or its unique record order');
  return structuredClone(packet);
}

/** The session reader has already established these ranges from actual paid packets.
 * Keep requested originals only until their exact interval has crossed the wire. */
export function pendingDossierWorkspace(workspace: ContextWorkspace): ContextWorkspace {
  const entries = workspace.entries.filter(({result}) => {
    const encoding = result.page?.encoding === 'canonical-json' || (!Array.isArray(result.value) && typeof result.value !== 'string')
      ? 'canonical-json' : Array.isArray(result.value) ? 'array-items' : 'utf16-string';
    const unit = encoding === 'array-items' ? 'items' : 'utf16';
    const total = result.page?.total ?? (encoding === 'canonical-json' ? canonical(result.value).length : (result.value as any).length);
    const key = hashJson({record:result.record,pointer:result.pointer,unit,encoding});
    const coverage = workspace.deliveryCoverage?.find(item => item.address === key && item.total === total);
    const offset = result.page?.offset ?? 0, end = result.page?.end ?? total;
    return !coverage?.ranges.some(range => range.offset <= offset && range.end >= end);
  });
  return {...workspace,entries};
}

/** Only accounting/process fields of technical grounds yield to exact addresses.
 * A record used as a claim container, classification, choice or resolution ground
 * remains complete even if its kind is normally technical. Unknown fields are retained.
 */
export function dossierMaterialProjection(packet: DossierAssessmentPacket) {
  const dictionary = dossierMaterialDictionary(packet);
  const substantive = new Set<string>();
  mapRecords({...packet,grounds:[]}, (row: DossierAssessmentRecord<unknown>) => {
    substantive.add(canonical(row.ref)); return row;
  });
  const accounting: Record<string, readonly string[]> = {
    'model-call':['projectId','draftId','requestId','profile','progressKey','ownerProcess','providerProcess','execution','recovery',
      'packet','budget','questionId','planAnswer','consumerIntent','assessmentApplication','startedAt','finishedAt',
      'requested','confirmed','request','response','usage','usageSource'],
    'research-budget-ledger':['projectId','segment','assignments'],
    'research-run':['projectId','draftId','environment','turns','limit','inputs','owner','requestChars'],
  };
  const records = dictionary.records.map(row => {
    const omitted = accounting[row.kind];
    if (!omitted || substantive.has(canonical(row.ref))) return row;
    const index = packet.grounds.findIndex(ground => canonical(ground.ref) === canonical(row.ref));
    requireCondition(index >= 0 && row.value && typeof row.value === 'object' && !Array.isArray(row.value),
      'discovery_dossier_transport_invalid', 'A technical ground needs its complete saved record');
    return {ref:row.ref,kind:row.kind,
      technical:{pointer:`/body/dossierPacket/grounds/${index}`,record:row.ref},
      content:Object.fromEntries(Object.entries(row.value).filter(([key]) => !omitted.includes(key)))};
  });
  return {...dictionary,records,
    instruction:'packet keeps every material, unknown, classification, choice and contradiction. A recordIndex selects records[index], deduplicated by exact Ref. Complete entries retain ref/kind/value. Technical entries retain all non-accounting content and an exact full-record pointer inside working.archive; read_context can read it on demand. A technical reference alone is not evidence of substantive support. Only the projected material requires complete coverage.'};
}

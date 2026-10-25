import { canonical } from '../canonical.js';
import { EngineError } from '../errors.js';
import {
  DOSSIER_ASSESSMENT_RESULT_CONTRACT, DOSSIER_QUALITY_DIMENSIONS,
  type DossierAssessmentPacket, type DossierAssessmentResult,
} from './research-model.js';

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_dossier_result_invalid', `[${field}] ${message}`, { field });
}
function shape(value: unknown, fields: readonly string[], at: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...fields].sort()))
    invalid(at, 'Missing or unknown fields of the terminal dossier result');
}
function text(value: unknown, at: string): void {
  if (typeof value !== 'string' || !value.trim()) invalid(at, 'Nonempty judgement or reason required');
}
function list(value: unknown, at: string, minimum = 0): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum) invalid(at, 'Expected an explicit list');
  if (new Set(value.map(item => canonical(item))).size !== value.length) invalid(at, 'Duplicate entries');
}

/** The one closed result decoder. The caller supplies a packet proven by the accepted dossier readers.
 * It checks references and preserves the saved 6.2 resolutions; it does not classify or resolve conflicts. */
export function decodeDossierAssessmentResult(input: unknown, packet: DossierAssessmentPacket): DossierAssessmentResult {
  // Reject non-JSON masquerades before consulting their fields. No coercion or stripping unknown keys.
  canonical(input);
  shape(input, ['contract', 'subject', 'verdict', 'reasons', 'quality', 'inventory', 'return'], 'result');
  if (input.contract !== DOSSIER_ASSESSMENT_RESULT_CONTRACT) invalid('contract', 'Unknown dossier result contract');
  if (canonical(input.subject) !== canonical(packet.subject)) invalid('subject', 'Result names another exact dossier');
  if (input.verdict !== 'supported' && input.verdict !== 'return') invalid('verdict', 'Expected supported or addressed return');
  list(input.reasons, 'reasons', 1); input.reasons.forEach((reason, i) => text(reason, `reasons.${i}`));

  const claims = new Set(packet.materials.map(item => canonical(item.address)));
  const unknowns = new Set(packet.unknowns.map(item => canonical(item.unknown.claim)));
  const records = new Set<string>();
  const add = (record: { ref: unknown } | null) => { if (record) records.add(canonical(record.ref)); };
  [packet.root, packet.manifest, ...Object.values(packet.basis), ...Object.values(packet.route), ...packet.grounds].forEach(add);
  for (const material of packet.materials) { add(material.container); add(material.assessment); }
  for (const relation of packet.contradictions) {
    relation.grounds.forEach(add);
    for (const side of relation.sides) if (side.application) records.add(canonical(side.application));
  }
  function bases(value: unknown, at: string): void {
    list(value, at, 1);
    value.forEach((entry, i) => {
      const key = entry && typeof entry === 'object' && !Array.isArray(entry) && Object.hasOwn(entry, 'claim') ? 'claim' : 'record';
      shape(entry, [key], `${at}.${i}`);
      if (!(key === 'claim' ? claims : records).has(canonical(entry[key])))
        invalid(`${at}.${i}`, 'A basis belongs to the exact proven snapshot inventory');
    });
  }
  shape(input.quality, DOSSIER_QUALITY_DIMENSIONS, 'quality');
  for (const dimension of DOSSIER_QUALITY_DIMENSIONS) {
    const row = input.quality[dimension], field = `quality.${dimension}`;
    shape(row, ['judgement', 'reason', 'bases'], field);
    if (row.judgement !== 'adequate' && row.judgement !== 'gap') invalid(field, 'Expected adequate or gap');
    if (input.verdict === 'supported' && row.judgement === 'gap') invalid(field, 'A declared quality gap needs an addressed return');
    text(row.reason, `${field}.reason`); bases(row.bases, `${field}.bases`);
  }
  shape(input.inventory, ['materials', 'unknowns', 'contradictions'], 'inventory');
  const inventory = {
    materials: packet.materials.map(item => item.address), unknowns: packet.unknowns.map(item => item.unknown.claim),
    contradictions: packet.contradictions.map(item => ({ id: item.contradiction.id,
      sides: item.sides.map(side => side.address), grounds: item.grounds.map(record => record.ref) })),
  };
  if (canonical(input.inventory) !== canonical(inventory))
    invalid('inventory', 'The exact ordered inventory keeps every material, unknown, both sides and resolution ground');
  if (input.verdict === 'supported') {
    if (input.return !== null) invalid('return', 'A supported result has no return');
    if (packet.contradictions.some(item => item.contradiction.blocking && item.contradiction.resolution.state === 'open'))
      invalid('verdict', 'An unresolved blocking contradiction cannot be hidden by supported');
  } else {
    shape(input.return, ['targets', 'reason', 'bases'], 'return');
    text(input.return.reason, 'return.reason'); bases(input.return.bases, 'return.bases');
    list(input.return.targets, 'return.targets', 1);
    input.return.targets.forEach((target, i) => {
      const field = `return.targets.${i}`;
      if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).length !== 1)
        invalid(field, 'An addressed return names one exact target');
      const key = Object.keys(target)[0]!, value = (target as Record<string, unknown>)[key];
      const valid = key === 'claim' ? claims.has(canonical(value)) : key === 'unknown' ? unknowns.has(canonical(value))
        : key === 'axis' ? typeof value === 'string' && Object.hasOwn(packet.manifest.value.axes, value)
        : key === 'contradiction' ? packet.contradictions.some(item => item.contradiction.id === value)
        : key === 'partialReason' ? Number.isSafeInteger(value) && (value as number) >= 0
          && (value as number) < packet.manifest.value.reasons.length : false;
      if (!valid) invalid(field, 'The return target belongs to this saved dossier');
    });
  }
  return structuredClone(input) as unknown as DossierAssessmentResult;
}

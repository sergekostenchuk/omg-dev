import { canonical, hashJson, type Json } from '../canonical.js';
import { EngineError } from '../errors.js';
import { isRef, reference, type Ref } from '../pipeline/contracts.js';
import type { Store, Revision } from '../storage/store.js';
import { readSelectedDossier, SELECTED_DOSSIER_KIND } from './selected-dossier.js';
import { readPartialDossier, DOSSIER_MANIFEST_KIND } from './dossier-manifest.js';
import { resolveClaimAddress, type ClaimAddress } from './claim-address.js';
import type { VariantSet } from './discovery-variants.js';
import {
  DOSSIER_ASSESSMENT_SUBJECT_CONTRACT, DOSSIER_ASSESSMENT_PACKET_CONTRACT,
  type DossierAssessmentSubject, type DossierAssessmentPacket, type DossierAssessmentRecord,
  type DossierAssessmentMaterial,
} from './research-model.js';

function invalid(field: string, message: string): never {
  throw new EngineError('discovery_dossier_assessment_invalid', `[${field}] ${message}`, { field });
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function shape(value: unknown, fields: string[], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !same(Object.keys(value).sort(), fields.sort())) invalid(field, 'Missing or unknown fields');
}
function exactRef(value: unknown, field: string): asserts value is Ref {
  shape(value, ['id', 'revision', 'hash'], field);
  if (!isRef(value)) invalid(field, 'An exact non-null Ref is required');
}
function exact<T = Json>(store: Store, at: Ref): Revision<T> {
  exactRef(at, 'record');
  const row = store.get<T>(at.id, at.revision);
  if (!row || !same(reference(row), at) || hashJson(row.value as never) !== at.hash)
    invalid('record', 'A saved exact ground is missing or substituted');
  return row;
}
function content<T>(row: Revision<T>): DossierAssessmentRecord<T> {
  return { ref: reference(row), kind: row.kind, value: row.value };
}
function identity(value: Omit<DossierAssessmentSubject, 'identity'>): string {
  return `dossier-assessment:${value.projectId}:${hashJson(value as never)}`;
}
function decodeSubject(input: unknown): DossierAssessmentSubject {
  shape(input, ['contract', 'kind', 'identity', 'projectId', 'root', 'manifest'], 'subject');
  if (input.contract !== DOSSIER_ASSESSMENT_SUBJECT_CONTRACT || input.kind !== 'dossier'
    || typeof input.projectId !== 'string' || !input.projectId) invalid('subject', 'Unknown dossier subject contract');
  shape(input.root, ['kind', 'ref'], 'root');
  if (input.root.kind !== 'selected' && input.root.kind !== 'partial') invalid('root.kind', 'Unknown snapshot route');
  exactRef(input.root.ref, 'root.ref'); exactRef(input.manifest, 'manifest');
  const { identity: id, ...basis } = input;
  if (id !== identity(basis as unknown as Omit<DossierAssessmentSubject, 'identity'>)) invalid('identity', 'The identity names the exact snapshot and contract');
  return structuredClone(input) as unknown as DossierAssessmentSubject;
}

/** Read-only preparation from an exact saved root, never from caller material or completeness flags.
 * The accepted selected/partial readers alone establish lineage, inventory and classifications. */
export async function prepareDossierAssessmentSubject(store: Store, project: string, root: unknown): Promise<DossierAssessmentPacket> {
  if (typeof project !== 'string' || !project) invalid('project', 'A project is required');
  exactRef(root, 'root');
  const row = exact(store, root);
  const selected = row.kind === SELECTED_DOSSIER_KIND ? readSelectedDossier(store, project, root) : null;
  if (!selected && row.kind !== DOSSIER_MANIFEST_KIND) invalid('root', 'A selected carrier or proven partial manifest is required');
  const partial = selected ? null : await readPartialDossier(store, project, root);
  const manifest = selected ? selected.manifest : partial!.record;
  const materialsProof = selected ? selected.materials : partial!.materials;
  const contradictionsProof = selected ? selected.contradictions : partial!.contradictions;
  const basis: Omit<DossierAssessmentSubject, 'identity'> = { contract: DOSSIER_ASSESSMENT_SUBJECT_CONTRACT,
    kind: 'dossier', projectId: project, root: { kind: selected ? 'selected' : 'partial', ref: root }, manifest: reference(manifest) };
  const subject: DossierAssessmentSubject = { ...basis, identity: identity(basis) };
  const record = (at: Ref | null): DossierAssessmentRecord | null => at === null ? null : content(exact(store, at));
  const handoff = partial?.handoff.value;
  const chosen = selected?.record.value;
  const setRef = chosen ? chosen.set : handoff!.set;
  const set = setRef ? exact<VariantSet>(store, setRef) : null;
  const route: DossierAssessmentPacket['route'] = {
    handoff: partial ? content(partial.handoff) as unknown as DossierAssessmentRecord : null,
    snapshot: record(chosen ? set!.value.snapshot : handoff!.snapshot),
    result: record(chosen ? setRef : handoff!.result), scope: record(chosen ? chosen.scope : handoff!.scope),
    set: set ? content(set) as unknown as DossierAssessmentRecord : null,
    member: record(chosen ? chosen.member : handoff!.choice), decision: record(chosen ? chosen.decision : handoff!.decision),
  };
  const materials: DossierAssessmentMaterial[] = materialsProof.map(item => {
    const resolved = resolveClaimAddress(store, item.claim);
    return { address: item.claim, value: resolved.claim, container: record(item.claim.container)!,
      status: item.status, assessment: record(item.assessment) };
  });
  const material = (address: ClaimAddress): DossierAssessmentMaterial => {
    const found = materials.find(item => same(item.address, address));
    if (!found) invalid('material', 'A snapshot side or unknown lost its material');
    return found;
  };
  const grounds = new Map<string, Ref>();
  if (selected) for (const refs of Object.values(selected.record.value.inventory))
    for (const at of refs) grounds.set(canonical(at), at);
  else for (const reason of manifest.value.reasons) for (const at of reason.grounds) grounds.set(canonical(at), at);
  const contradictions = contradictionsProof.map(proof => {
    const sides = proof.sides.map(side => {
      const found = material(side.claim);
      if (found.status !== side.status || !same(found.assessment?.ref ?? null, side.assessment))
        invalid('contradictions', 'A side differs from its historical material classification');
      if (side.application) grounds.set(canonical(side.application), side.application);
      return { ...found, application: side.application };
    }) as DossierAssessmentPacket['contradictions'][number]['sides'];
    const refs = proof.contradiction.resolution.state === 'open' ? [] : proof.contradiction.resolution.grounds;
    return { contradiction: proof.contradiction, sides, grounds: refs.map(at => record(at)!) };
  });
  return structuredClone({ contract: DOSSIER_ASSESSMENT_PACKET_CONTRACT, subject,
    root: content(row), manifest: content(manifest),
    basis: { draft: record(manifest.value.draft)!, frame: record(manifest.value.frame)!, plan: record(manifest.value.plan)! },
    route, coverage: selected?.coverage ?? null, materials,
    unknowns: manifest.value.unknowns.map(unknown => ({ unknown, material: material(unknown.claim) })),
    contradictions, grounds: [...grounds].sort(([a], [b]) => a.localeCompare(b)).map(([, at]) => record(at)!),
  });
}

/** Prove the presented subject against its saved root; no current-head admission is performed. */
export async function requireDossierAssessmentSubject(store: Store, project: string, input: unknown): Promise<DossierAssessmentPacket> {
  const subject = decodeSubject(input);
  if (subject.projectId !== project) invalid('project', 'The subject belongs to another project');
  const packet = await prepareDossierAssessmentSubject(store, project, subject.root.ref);
  if (!same(packet.subject, subject)) invalid('subject', 'The subject does not match its proven exact snapshot');
  return packet;
}

/** A serialized packet is only a candidate: rebuild its proof and compare every byte of mandatory content. */
export async function requireDossierAssessmentPacket(store: Store, project: string, input: unknown): Promise<DossierAssessmentPacket> {
  shape(input, ['contract', 'subject', 'root', 'manifest', 'basis', 'route', 'coverage', 'materials', 'unknowns', 'contradictions', 'grounds'], 'packet');
  if (input.contract !== DOSSIER_ASSESSMENT_PACKET_CONTRACT) invalid('contract', 'Unknown dossier packet contract');
  const packet = await requireDossierAssessmentSubject(store, project, input.subject);
  if (!same(packet, input)) invalid('packet', 'The packet omits or substitutes saved dossier content');
  return packet;
}

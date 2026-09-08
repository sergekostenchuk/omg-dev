import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { canonical, type Json } from '../canonical.js';
import { Evidence, type Observation, type Source, type Selector } from '../evidence/evidence.js';
import type { Store } from '../storage/store.js';
import type { FieldSpec } from '../discovery/discovery.js';
import type { Finding, Ref } from '../pipeline/contracts.js';
import { workspacePath } from '../runtime/environment.js';
import type { TechnicalReport } from './research-contracts.js';

const text: Json = { type: 'string', minLength: 1 };
const object = (properties: Record<string, Json>): Json => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const citation: Json = { type: 'integer', minimum: 0 };
const ids: Json = { type: 'array', uniqueItems: true, items: text };

/** Keep recorded R1/R2 schemas intact; new R2 drafts opt in as a whole. */
export function withTypedBasis(spec: FieldSpec): FieldSpec {
  const schema = structuredClone(spec.schema) as { required: string[]; properties: Record<string, Json> };
  schema.properties['facts'] = { type: 'array', items: object({ id: text, claim: text,
    evidence: object({ kind: { const: 'repository-file' }, citation }) }) };
  schema.properties['documents'] = { type: 'array', items: object({ id: text, claim: text,
    kind: { enum: ['owner-document', 'document-observation'] }, citation, quote: text, designs: ids, gaps: ids }) };
  schema.required.push('documents');
  return { ...spec, basisContract: 'typed-v1', schema: schema as unknown as Json,
    prompt: `${spec.prompt}\nКонтракт оснований typed-v1 заменяет ручной path: facts[].evidence={kind:"repository-file",citation:N}, где N — индекс с нуля в citations ЭТОГО ответа. Код связывает точную цитату и вычисляет путь. Для нескольких файлов создай отдельные атомарные факты. Документы сохраняй в documents:[{id,claim,kind,citation,quote,designs:[id],gaps:[id]}]. quote — точная непустая цитата выбранного наблюдения. kind=owner-document означает ссылку на явно выраженное намерение владельца, его авторство и применимость ещё проверяет оценщик; способ загрузки документа сам по себе полномочий не доказывает. kind=document-observation означает «сообщено в документе», а не подтверждённое поведение репозитория или живого исполнения. Документ должен обосновывать конкретное решение designs или неизвестное gaps. Документ не является repository fact, доказательством реализации или самостоятельным подтверждением среды. Решения модели остаются проектными предложениями. Не удаляй относящееся к вопросу документальное основание ради прохождения проверки.` };
}

export interface ResolvedResearchBasis {
  id: string; kind: 'repository-file' | 'owner-document' | 'document-observation';
  source: Ref; selector: Selector; repositoryPath: string | null;
  proofLimit: 'repository-observation' | 'quoted-intent-requires-attribution' | 'reported-not-runtime-proof';
  quote: string | null; designs: string[]; gaps: string[];
}

/** Indices address the answer's ordered, exact citations, never a mutable global catalogue. */
export function resolveResearchBasis(store: Store, project: string, report: TechnicalReport, observations: Observation[], root: string,
  field: string): { bases: ResolvedResearchBasis[]; findings: Finding[] } {
  const bases: ResolvedResearchBasis[] = [], findings: Finding[] = [], evidence = new Evidence(store);
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, field, message });
  const used = new Set<string>();
  const observed = (id: string, index: number) => {
    const observation = Number.isSafeInteger(index) && index >= 0 ? observations[index] : undefined;
    if (!observation || observation.projectId !== project || !evidence.verify(observation)) {
      fail('research_basis_invalid', id, 'Basis must select an exact current citation of this project'); return null;
    }
    return { observation, source: store.get<Source>(observation.source.id, observation.source.revision)! };
  };
  for (const entry of [...report.facts, ...report.designs, ...report.gaps, ...(report.documents ?? [])]) {
    if (used.has(entry.id)) fail('research_basis_duplicate', entry.id, 'Report identifiers must be unique across facts, designs, gaps and documents');
    used.add(entry.id);
  }
  for (const fact of report.facts) {
    if (!fact.evidence || fact.evidence.kind !== 'repository-file' || Object.hasOwn(fact, 'path')) {
      fail('repository_evidence_required', fact.id, 'Use repository-file with an exact citation index; the engine computes the path'); continue;
    }
    const selected = observed(fact.id, fact.evidence.citation);
    if (!selected) continue;
    const { source, observation } = selected;
    if (source.value.origin.kind !== 'file') {
      fail('repository_evidence_required', fact.id, 'A document cannot be promoted to a repository fact'); continue;
    }
    try {
      const path = relative(realpathSync(root), source.value.origin.location);
      if (realpathSync(workspacePath(root, path)) !== source.value.origin.location) throw Error('Different source path');
      bases.push({ id: fact.id, kind: 'repository-file', source: observation.source, selector: observation.selector,
        repositoryPath: path, proofLimit: 'repository-observation', quote: null, designs: [], gaps: [] });
    } catch { fail('research_source_foreign', fact.id, 'Repository citation must belong to the actual research workspace'); }
  }
  if (!Array.isArray(report.documents)) fail('research_basis_missing', field, 'Typed R2 requires an explicit documents array, including when empty');
  for (const document of report.documents ?? []) {
    const selected = observed(document.id, document.citation);
    if (!selected) continue;
    const { source, observation } = selected;
    if (!['owner-document', 'document-observation'].includes(document.kind) || source.value.origin.kind !== 'owner-document'
      || source.value.provenance && document.kind==='owner-document') {
      fail('document_evidence_required', document.id, 'Documentary basis requires a document source and an explicit proof limit'); continue;
    }
    const original = typeof observation.value === 'string' ? observation.value : canonical(observation.value);
    if (typeof document.quote !== 'string' || !document.quote.trim() || !original.includes(document.quote)) {
      fail('document_quote_invalid', document.id, 'The quote must occur verbatim inside the selected observation'); continue;
    }
    if (!Array.isArray(document.designs) || !Array.isArray(document.gaps) || !document.designs.length && !document.gaps.length
      || !document.designs.every(id => report.designs.some(d => d.id === id))
      || !document.gaps.every(id => report.gaps.some(g => g.id === id))) {
      fail('document_consumer_missing', document.id, 'A document must support an identified design or gap, never a repository fact'); continue;
    }
    bases.push({ id: document.id, kind: document.kind, source: observation.source, selector: observation.selector,
      repositoryPath: null, proofLimit: document.kind === 'owner-document' ? 'quoted-intent-requires-attribution' : 'reported-not-runtime-proof',
      quote: document.quote, designs: document.designs, gaps: document.gaps });
  }
  return { bases, findings };
}

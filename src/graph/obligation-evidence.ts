import { canonical } from '../canonical.js';
import type { FieldSpec } from '../discovery/discovery.js';
import { sourceIsCurrent, type Source, type Observation } from '../evidence/evidence.js';
import { reference, type Finding } from '../pipeline/contracts.js';
import type { TechnicalReport } from './research-contracts.js';
import type { Store } from '../storage/store.js';
import { EngineError } from '../errors.js';
import type { RuntimeEvidence } from './runtime-evidence.js';
export const OBLIGATION_EVIDENCE_PAUSES = new Set(['environment_confirmation_required','implementation_confirmation_required','obligation_assignment_required','obligation_document_source_unavailable']);

export function requireDocumentarySources(store: Store, project: string, spec: FieldSpec): void {
  if (spec.obligationContract !== 'evidence-v1') return;
  for (const obligation of spec.obligations ?? []) {
    const allowance = obligation.assignment?.documentaryAllowance;
    if (allowance && !allowance.sources.some(ref => {
      const source = store.get<Source>(ref.id);
      return source?.kind === 'source' && source.value.projectId === project && ['owner-document', 'web'].includes(source.value.origin.kind)
        && canonical(reference(source)) === canonical(ref) && sourceIsCurrent(source.value);
    })) throw new EngineError('obligation_document_source_unavailable',`[${obligation.id}] The exact document permitted by the scope is unavailable or changed; do not spend another call against an unusable evidence contract`);
  }
}

/** Issue this contract only to new R2 drafts; recorded older questions keep
 * their schema/prompt and are not retroactively re-adjudicated. */
export function withObligationEvidence(spec: FieldSpec): FieldSpec {
  return { ...spec, obligationContract: 'evidence-v1', prompt: `${spec.prompt}\nДля coverage исходного обязательства соблюдай assignment.kind, а не только наличие ответа. repository-fact требует относящегося к обязательству facts; design-decision — designs для его потребителя; owner-decision — явно атрибутированное намерение владельца из owner-document, связанное с этим решением. Документальные основания связывай через documents[].designs с решением, указанным в coverage.designs. environment-confirmation не закрывается кодом, флагами запуска, проектным решением или произвольной цитатой. Только явно заданная assignment.documentaryAllowance разрешает использовать document-observation из одной из точных sources строго в пределах claimLimit, без утверждения живого исполнения. При отсутствии фактического подтверждения среды или реализации оставь неизвестное явным; типизированная техническая пауза не означает нового решения владельца и не разрешает менять вид или срок обязательства.` + (spec.obligations?.some(o=>o.assignment?.runtimeCheck) ? '\nЕсли assignment.runtimeCheck задан, допустим другой путь: готовый источник с provenance.kind=runtime-observation, созданный движком после выполнения объявленной проверки. Цитируй его как document-observation; движок проверит подлинный журнал, точную конфигурацию и код и доставит оценщику полный результат и исходники проверки. Одна декларация runtimeCheck, скопированный текст журнала или имя файла этого не заменяют. Ненулевой exitCode — наблюдение, а не успешное подтверждение работоспособности. Оцени смысл результата для конкретного обязательства. Модель не запускает проверку и не задаёт программу: observe-runtime — отдельное действие оператора; при отсутствии готового результата сохраняй техническую паузу.' : '') };
}

export function obligationEvidenceFindings(spec: FieldSpec, report: TechnicalReport, observations: Observation[], runtimeProofs: RuntimeEvidence[] = []): Finding[] {
  if (spec.obligationContract !== 'evidence-v1') return [];
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({code,target,field:spec.field,message});
  for (const obligation of spec.obligations ?? []) {
    const assignment = obligation.assignment;
    if (!assignment) { fail('obligation_assignment_required',obligation.id,'An unassigned obligation remains an explicit question; do not infer its knowledge kind or defer it'); continue; }
    const item = report.coverage?.find(c => c.obligation === obligation.id);
    if (!item) continue; // The common coverage validator reports the missing member.
    if (!Array.isArray(item.facts) || !Array.isArray(item.designs) || !Array.isArray(item.gaps)) continue;
    const facts = report.facts.filter(f => item.facts.includes(f.id));
    const designs = report.designs.filter(d => item.designs.includes(d.id) && d.consumer === obligation.consumer);
    const documents = (report.documents ?? []).filter(d => d.designs.some(id => designs.some(design => design.id === id)));
    switch (assignment.kind) {
      case 'repository-fact':
        if (!facts.some(f => f.evidence?.kind === 'repository-file')) fail('obligation_repository_evidence_required',obligation.id,'A repository obligation cannot be closed by a design or documentary report');
        break;
      case 'design-decision':
        if (!designs.length) fail('obligation_design_required',obligation.id,'Observed code alone does not make the required design decision for its consumer');
        break;
      case 'owner-decision':
        if (!documents.some(d => d.kind === 'owner-document')) fail('obligation_owner_intent_required',obligation.id,'Only an attributable owner-intent document may support this decision; the assessor must verify that attribution');
        break;
      case 'environment-confirmation': {
        const allowance = assignment.documentaryAllowance;
        const supported = runtimeProofs.some(proof=>proof.obligation===obligation.id&&documents.some(d=>d.id===proof.document))
          || allowance && documents.some(d => d.kind === 'document-observation' && observations[d.citation]
          && allowance.sources.some(source => canonical(source) === canonical(observations[d.citation]!.source)));
        if (!supported) fail(allowance ? 'obligation_document_evidence_required' : 'environment_confirmation_required',obligation.id,
          allowance ? 'Use a document-observation from an exact approved source within its claimLimit; another source or owner-intent quote cannot substitute'
            : 'Actual environment confirmation is unavailable. Code, model confidence and unapproved documentary reports do not close it; preserve a technical pause');
        break;
      }
      case 'post-implementation-proof':
        fail('implementation_confirmation_required',obligation.id,'The current answer does not contain an executed implementation result; a design or document is not that result');
        break;
      default:
        fail('obligation_assignment_required',obligation.id,'Unknown knowledge kind cannot be treated as a resolved obligation');
    }
  }
  return findings;
}

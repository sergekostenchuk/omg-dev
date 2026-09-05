import type { Json } from "../canonical.js";
import type { Finding, Stage } from "../pipeline/contracts.js";

type Row = Record<string, any>;
export function preparationFindings(stage: Stage, fields: Record<string, Json>, upstream: (stage: Stage) => Record<string, Json> | null,
  graphOutcomes: string[]): Finding[] {
  const findings: Finding[] = [];
  const fail = (code: string, target: string, message: string) => findings.push({ code, target, message });
  const unique = (rows: Row[], label: string) => {
    if (new Set(rows.map(row => row['id'])).size !== rows.length) fail("preparation_duplicate", label, "Semantic identifiers must be unique");
  };
  const preparation = (stage === "discovery" ? fields['preparation'] : upstream("discovery")?.['preparation']) as Row | undefined;
  if (!preparation) { fail("preparation_missing", stage, "Enriched initial research is required for new work"); return findings; }
  const actors = preparation['actors'] as Row[], outcomes = preparation['outcomes'] as Row[];
  if (stage === "discovery") {
    unique(actors, "actors"); unique(outcomes, "outcomes");
    for (const outcome of outcomes) if (!actors.some(actor => actor['id'] === outcome['beneficiary'])) fail("beneficiary_missing", outcome['id'], "Outcome beneficiary must be an identified actor");
    const scenarios = Object.values(preparation['journeys'] as Record<string, Row>).flatMap(variant => variant['scenarios'] as Row[]);
    for (const scenario of scenarios) {
      if (!actors.some(actor => actor['id'] === scenario['actor'])) fail("journey_actor_missing", scenario['actor'], "Scenario actor is unknown");
      if (!outcomes.some(outcome => outcome['id'] === scenario['outcome'])) fail("journey_outcome_missing", scenario['outcome'], "Scenario outcome is unknown");
    }
    for (const actor of actors) if (!scenarios.some(scenario => scenario['actor'] === actor['id'])) fail("actor_journey_missing", actor['id'], "Each actor needs an applicable product journey");
    for (const risk of preparation['risks'] as Row[]) if (!outcomes.some(outcome => outcome['id'] === risk['affectedOutcome'])) fail("risk_outcome_missing", risk['id'], "Risk must identify an affected outcome");
    for (const unknown of preparation['unknowns'] as Row[]) if (unknown['blocksCurrentStage']) fail("preparation_unresolved", unknown['id'], unknown['question']);
    return findings;
  }
  const sections = (stage === "concept" ? fields['conceptSections'] : upstream("concept")?.['conceptSections']) as Row[] | undefined;
  if (!sections) { fail("concept_requirements_missing", stage, "Addressable concept requirements are required"); return findings; }
  const requirements = sections.flatMap(section => section['requirements'] as Row[]);
  if (stage === "concept") {
    unique(sections, "conceptSections"); unique(requirements, "conceptRequirements");
    for (const requirement of requirements) {
      if (!actors.some(actor => actor['id'] === requirement['beneficiary'])) fail("beneficiary_missing", requirement['id'], "Requirement must name a product beneficiary");
      if (!outcomes.some(outcome => outcome['id'] === requirement['outcome'] && outcome['beneficiary'] === requirement['beneficiary'])) fail("requirement_outcome_missing", requirement['id'], "Requirement must preserve its outcome and beneficiary");
    }
    for (const outcome of outcomes) if (!requirements.some(requirement => requirement['outcome'] === outcome['id'])) fail("outcome_uncovered", outcome['id'], "Concept must cover each declared product outcome");
  }
  if (stage === "operation-map") {
    const model = fields['operationRequirements'] as Row;
    const rows = model['outcomes'] as Row[], coverage = model['conceptCoverage'] as Row[];
    for (const outcome of outcomes) if (!rows.some(row => row['outcome'] === outcome['id'])) fail("outcome_uncovered", outcome['id'], "Operation map preparation must cover each product outcome");
    for (const row of rows) if (!graphOutcomes.includes(row['outcome'])) fail("map_outcome_missing", row['outcome'], "Prepared outcome must exist in the actual map");
    for (const binding of coverage) if (!requirements.some(requirement => requirement['id'] === binding['requirement'] && requirement['outcome'] === binding['outcome']))
      fail("concept_coverage_foreign", binding['requirement'], "Coverage must preserve the requirement's declared outcome");
    for (const requirement of requirements) if (!coverage.some(binding => binding['requirement'] === requirement['id'])) fail("requirement_uncovered", requirement['id'], "Map preparation must cover the concept requirement");
  }
  const behaviors = (stage === "specification" ? fields['behaviorContracts'] : upstream("specification")?.['behaviorContracts']) as Row[] | undefined;
  if (stage === "specification" && behaviors) {
    unique(behaviors, "behaviorContracts");
    for (const contract of behaviors) {
      if (!actors.some(actor => actor['id'] === contract['actor'])) fail("behavior_actor_missing", contract['id'], "Behavior must identify its actor");
      if (!graphOutcomes.includes(contract['outcome'])) fail("behavior_outcome_missing", contract['id'], "Behavior outcome must exist in the operation map");
      for (const id of contract['requirements'] as string[]) if (!requirements.some(requirement => requirement['id'] === id && requirement['outcome'] === contract['outcome'])) fail("behavior_requirement_foreign", id, "Behavior must preserve the requirement's outcome");
    }
    for (const requirement of requirements) if (!behaviors.some(contract => contract['requirements'].includes(requirement['id']))) fail("requirement_uncovered", requirement['id'], "A concept requirement has no behavior contract");
  }
  if (stage === "features") {
    if (!behaviors) { fail("behavior_contracts_missing", stage, "Prepared features require enriched specification contracts"); return findings; }
    const features = fields['features'] as unknown as Row[], details = fields['featurePreparation'] as unknown as Row[];
    if (details.length !== features.length || new Set(details.map(row => row['featureTitle'])).size !== details.length) fail("feature_preparation_incomplete", stage, "Each feature needs one preparation record");
    for (const detail of details) {
      if (!features.some(feature => feature['title'] === detail['featureTitle'] && feature['outcome'] === detail['outcome'])) fail("feature_preparation_foreign", detail['featureTitle'], "Feature preparation must bind its declared feature and outcome");
      if (!actors.some(actor => actor['id'] === detail['beneficiary'])) fail("beneficiary_missing", detail['featureTitle'], "Feature must identify its beneficiary");
      if (!outcomes.some(outcome => outcome['id'] === detail['outcome'] && outcome['beneficiary'] === detail['beneficiary']))
        fail("feature_beneficiary_foreign", detail['featureTitle'], "Feature must preserve the beneficiary of its outcome and concept requirements");
      for (const ref of detail['behaviorContracts'] as string[]) if (!behaviors.some(contract => contract['id'] === ref && contract['outcome'] === detail['outcome'])) fail("feature_contract_foreign", ref, "Feature must bind a behavior contract with the same outcome");
      for (const ref of detail['requirements'] as string[]) if (!requirements.some(requirement => requirement['id'] === ref && requirement['outcome'] === detail['outcome'])) fail("feature_requirement_foreign", ref, "Feature must preserve its concept requirement's outcome");
      const inherited = new Set(behaviors.filter(contract => detail['behaviorContracts'].includes(contract['id'])).flatMap(contract => contract['requirements'] as string[]));
      if (inherited.size !== detail['requirements'].length || (detail['requirements'] as string[]).some(id => !inherited.has(id)))
        fail("feature_requirements_incomplete", detail['featureTitle'], "Feature must preserve exactly the requirements of its bound behavior contracts");
      for (const interaction of detail['interactions'] as Row[]) if (!graphOutcomes.includes(interaction['outcome'])) fail("feature_interaction_missing", interaction['outcome'], "Feature interaction must bind a known map outcome");
      for (const question of detail['remainingQuestions'] as Row[]) if (question['blocksCurrentStage']) fail("feature_preparation_unresolved", detail['featureTitle'], question['question']);
    }
    for (const contract of behaviors) if (!details.some(detail => detail['behaviorContracts'].includes(contract['id']))) fail("behavior_uncovered", contract['id'], "Each behavior contract must have a prepared feature consumer");
  }
  return findings;
}

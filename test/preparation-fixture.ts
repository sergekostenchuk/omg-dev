import type { Json } from "../src/canonical.js";
import { JOURNEY_VARIANTS } from "../src/discovery/preparation-contracts.js";

// Explicit accepted design data for testing downstream contracts. This fixture
// does not claim that an LLM investigated or implemented the described product.
export function preparationValue(project: string): Json {
  const actor = `${project}-user`, outcome = `${project}-result`;
  const active = new Set(["success", "repeated_use", "invalid_incomplete_input", "safe_failure"]);
  return { problem: "The user needs a local transformation result", existingSituation: "A new stateless CLI product is being designed",
    actors: [{ id: actor, role: "CLI user", benefit: "Receive a validated transformation result", channels: ["CLI"] }],
    outcomes: [{ id: outcome, beneficiary: actor, result: "A validated transformation output", success: ["The output matches the requested input transformation"] }],
    journeys: Object.fromEntries(JOURNEY_VARIANTS.map(name => [name, active.has(name)
      ? { applicability: "applicable", reason: "The CLI accepts repeated valid and invalid requests", scenarios: [{ actor, outcome,
        entry: "CLI invocation", steps: ["Read input", "Validate input", "Produce output"], success: ["Return the requested result"], failure: ["Reject invalid input without publishing a result"], recovery: [] }] }
      : { applicability: "not_applicable", reason: `This explicitly scoped stateless CLI fixture has no ${name} workflow; no existing service or retained user state is being migrated`, scenarios: [] }])),
    constraints: [{ id: `${project}-local`, rule: "Use local input and output only", basis: "Accepted fixture scope" }],
    externalSystems: [], risks: [{ id: `${project}-invalid`, consequence: "Incorrect output", affectedOutcome: outcome, mitigation: "Validate before publishing" }], unknowns: [],
  };
}

export function preparedField(project: string, field: string): Json {
  const actor = `${project}-user`, outcome = `${project}-result`, requirement = `${project}-R1`, contract = `${project}-B1`;
  if (field === "preparation") return preparationValue(project);
  if (field === "conceptSections") return [{ id: `${project}-concept`, title: "Local transformation", requirements: [{ id: requirement,
    statement: "Transform valid input and reject invalid input", benefit: "Reliable local result", beneficiary: actor, outcome, acceptance: ["Invalid input produces no result"] }] }];
  if (field === "operationRequirements") return { outcomes: [{ outcome, producerResponsibility: "Transform and validate input", consumers: [actor],
    prerequisites: ["Input is available"], success: ["Valid result is published"], failure: ["Invalid input is rejected"], recoveryResponsibility: "CLI caller can retry with corrected input" }],
    conceptCoverage: [{ requirement, outcome }] };
  if (field === "behaviorContracts") return [{ id: contract, requirements: [requirement], actor, entry: "CLI invocation", inputs: ["Local input"], outcome,
    success: ["Requested output is returned"], failures: ["Invalid input is rejected"], forbiddenEffects: ["Publishing invalid output"],
    state: { durability: "none", writer: "transformation service", authority: "CLI caller", rollback: "Do not publish invalid output",
      restart: "Start a new stateless invocation", replay: "Same input returns the same output" }, compatibility: "New standalone CLI", proof: "Invoke CLI with valid and invalid input" }];
  if (field === "featurePreparation") return [{ featureTitle: "Deliver result", outcome, requirements: [requirement], behaviorContracts: [contract],
    beneficiary: actor, benefit: "Obtain a validated result", success: ["Valid result is returned"], failures: ["Invalid input produces no result"], interactions: [], remainingQuestions: [] }];
  if (field === "features") return [{ title: "Deliver result", outcome, requirements: [0] }];
  if (["acceptance", "journey", "behavior", "constraints"].includes(field)) return [`${field} for ${project}`];
  return `${field} for ${project}`;
}

export const researchInput = (project: string, brief = `Existing request for ${project}`, objective = `Deliver ${project} outcome`) =>
  JSON.stringify({ brief, objective, preparation: preparationValue(project) });

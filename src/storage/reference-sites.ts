const HASH = /^[a-f0-9]{64}$/;

export interface StoredReference { id: string; revision: number; hash: string }
export interface ReferenceSite { field: string; ref: StoredReference }

const INDEX = Symbol("array-index");
const KEY = Symbol("object-key");
type PathSegment = string | number;
type PathPatternSegment = string | typeof INDEX | typeof KEY;
type PathPattern = readonly PathPatternSegment[];

interface RecordReferenceSemantics {
  kind: string;
  contract: string | null;
  data: readonly PathPattern[];
}

const contextLookupData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, "focus", "value"],
  [...prefix, "workspace", "entries", INDEX, "result", "value"],
];

const assessmentSessionData = (): PathPattern[] => [
  ...contextLookupData([]),
  ["notes", INDEX, "response"],
  ["result"],
];

const researchActionData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, "value"],
  [...prefix, "upserts"],
];

const observationData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, "value"],
  [...prefix, "observations", INDEX, "value"],
  [...prefix, "results"],
  [...prefix, "proposal"],
  [...prefix, "requested", "value"],
];

const researchTurnData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  ...researchActionData([...prefix, "action"]),
  ...observationData([...prefix, "observation"]),
  ...observationData([...prefix, "feedback"]),
];

const synthesisSessionData = (): PathPattern[] => [
  ...contextLookupData([]),
  ["basis", "materials", INDEX, "value", "value"],
  ["basis", "materials", INDEX, "value", "observations", INDEX, "value"],
  ["basis", "materials", INDEX, "value", "proposal"],
  ...researchActionData(["basis", "previousProposal"]),
  ...researchActionData(["notes", INDEX, "proposal"]),
  ...researchActionData(["result"]),
  ...researchActionData(["pause"]),
];

const contextData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, "value"],
  [...prefix, "fields"],
  [...prefix, "questions", INDEX, "schema"],
  [...prefix, "question", "schema"],
  [...prefix, "observations", INDEX, "value"],
  [...prefix, "discoveryContext", "fields", KEY, "value"],
  [...prefix, "stageNeighbors", "fields", INDEX, "value"],
  [...prefix, "prerequisites", INDEX, "fields"],
  [...prefix, "operationMap", "graph"],
  [...prefix, "operationMap", "research", INDEX, "fields"],
  [...prefix, "contextWorkspace", INDEX, "value"],
  [...prefix, "workingSelections", INDEX, "value", "value"],
  [...prefix, "workingSelections", INDEX, "value", "observations", INDEX, "value"],
  [...prefix, "savedMaterials", INDEX, "value", "value"],
  [...prefix, "savedMaterials", INDEX, "value", "observations", INDEX, "value"],
  [...prefix, "savedMaterials", INDEX, "value", "proposal"],
  [...prefix, "synthesisMaterials", INDEX, "value", "value"],
  [...prefix, "synthesisMaterials", INDEX, "value", "observations", INDEX, "value"],
  [...prefix, "synthesisMaterials", INDEX, "value", "proposal"],
  [...prefix, "focus", "value"],
  [...prefix, "focus", "observations", INDEX, "value"],
  [...prefix, "readings", INDEX, "observations", INDEX, "value"],
  [...prefix, "priorEvidence", INDEX, "value"],
  [...prefix, "directReadings", INDEX, "observation", "value"],
  [...prefix, "selectedContext", INDEX, "value"],
  [...prefix, "currentProposal"],
  [...prefix, "previousProposal", "value"],
  [...prefix, "previousProposal", "upserts"],
  [...prefix, "checkpoints", INDEX, "proposal"],
  [...prefix, "checkpoints", INDEX, "observations", INDEX, "value"],
  [...prefix, "checkpoint", "proposal"],
  [...prefix, "checkpoint", "observations", INDEX, "value"],
  [...prefix, "assessmentNotes", INDEX, "response"],
  ...researchActionData([...prefix, "synthesisNotes", INDEX, "proposal"]),
  ...researchTurnData([...prefix, "history", INDEX]),
  ...researchTurnData([...prefix, "currentRead"]),
  [...prefix, "candidate", "changes", INDEX, "value"],
  [...prefix, "proposalChanges", "changes", INDEX, "value"],
  [...prefix, "conclusions"],
  [...prefix, "conclusionRefs"],
  ...["brief", "objective", "problem", "existingSituation", "actors", "outcomes", "constraints", "risks",
    "unknowns", "requirements", "acceptance", "specificationConstraints", "featureIndex"]
    .map(field => [...prefix, "core", field] as PathPattern),
];

/**
 * Stored contracts whose bodies contain JSON data next to engine references.
 * Everything outside these declared data subtrees keeps the historical
 * structural reference scan. Unknown contracts therefore fail closed instead
 * of silently borrowing the semantics of another era.
 */
const RECORD_REFERENCE_SEMANTICS: readonly RecordReferenceSemantics[] = [
  { kind: "decision", contract: null, data: [["value"]] },
  { kind: "design", contract: null, data: [["value"]] },
  { kind: "fact", contract: null, data: [["observation", "value"]] },
  { kind: "discovery-draft", contract: null, data: [["fields"]] },
  { kind: "question", contract: null, data: [["spec", "schema"]] },
  { kind: "stage", contract: null, data: [["content", "fields"]] },
  { kind: "research-answer", contract: null, data: [["value"]] },
  { kind: "research-assessment", contract: null, data: [["value"], ["observations", INDEX, "value"]] },
  { kind: "research-checkpoint", contract: null, data: [["proposal"], ["observations", INDEX, "value"]] },
  { kind: "research-context", contract: null, data: contextData(["body"]) },
  { kind: "reader-result", contract: "reader-result/v2", data: [["observations", INDEX, "value"]] },
  { kind: "pilot-reading", contract: null, data: [["observation", "value"]] },
  { kind: "research-turn", contract: "research-consumer-turn/v1", data: [
    ...researchActionData(["action"]), ...observationData(["observation"]),
  ] },
  { kind: "research-consumer-intent", contract: "research-consumer-intent/v1", data: contextData(["cursor", "context"]) },
  { kind: "assessment-application", contract: "assessment-application/v1", data: contextData(["context"]) },
  { kind: "assessment-paid-origin", contract: "assessment-paid-origin/v1", data: [
    ...contextData(["context"]), ["runtime", "supporting", INDEX, "value"],
  ] },
  { kind: "assessment-paid-origin", contract: "assessment-paid-origin/v2", data: [
    ...contextData(["context"]), ["runtime", "supporting", INDEX, "value"],
  ] },
  { kind: "assessment-session", contract: null, data: assessmentSessionData() },
  { kind: "assessment-session", contract: "assessment-application/v1", data: assessmentSessionData() },
  { kind: "synthesis-session", contract: null, data: synthesisSessionData() },
  { kind: "synthesis-session", contract: "synthesis-session/v2", data: synthesisSessionData() },
  { kind: "web-capture", contract: "web-capture/v1", data: [["response"]] },
  { kind: "om-integrity", contract: "om-integrity/v1", data: [["findings", INDEX, "ref"]] },
];

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReference = (value: Record<string, unknown>): value is Record<string, unknown> & StoredReference =>
  typeof value["id"] === "string" && Number.isSafeInteger(value["revision"]) && Number(value["revision"]) > 0
  && typeof value["hash"] === "string" && HASH.test(value["hash"] as string);

function contractOf(value: unknown): string | null {
  return object(value) && typeof value["contract"] === "string" ? value["contract"] : null;
}

function matches(pattern: PathPattern, path: readonly PathSegment[]): boolean {
  return pattern.length === path.length && pattern.every((segment, index) =>
    segment === INDEX ? typeof path[index] === "number"
      : segment === KEY ? typeof path[index] === "string"
        : segment === path[index]);
}

function shown(path: readonly PathSegment[]): string {
  return path.map(segment => typeof segment === "number" ? `[${segment}]` : segment)
    .join(".").replaceAll(".[", "[");
}

/** Pure enumeration used by om-fsck and by callers that need to test a record contract without a database. */
export function referenceSites(kind: string, value: unknown): ReferenceSite[] {
  const contract = contractOf(value);
  const data = RECORD_REFERENCE_SEMANTICS
    .filter(rule => rule.kind === kind && rule.contract === contract)
    .flatMap(rule => rule.data);
  const sites: ReferenceSite[] = [];
  const visit = (current: unknown, path: PathSegment[]): void => {
    if (data.some(pattern => matches(pattern, path))) return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!object(current)) return;
    if (isReference(current)) {
      sites.push({ field: shown(path), ref: current });
      return;
    }
    for (const [key, item] of Object.entries(current)) visit(item, [...path, key]);
  };
  visit(value, []);
  return sites;
}

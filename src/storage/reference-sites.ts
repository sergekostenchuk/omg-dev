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
  refs?: readonly PathPattern[];
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

const contextBodyData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
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

const capacityData = (prefix: readonly PathPatternSegment[]): PathPattern[] =>
  contextBodyData([...prefix, 'mandatory', 'projection', 'subject']);
const finalSubjectRefs = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, 'dossier', 'root', 'ref'], [...prefix, 'dossier', 'manifest'],
  ...['assessment', 'draft', 'frame', 'plan', 'session', 'application', 'call', 'request', 'response']
    .map(key => [...prefix, 'basis', key]),
  ...['question', 'fact', 'acceptance', 'source'].map(key => [...prefix, 'basis', 'brief', key]),
];
const finalAssessmentSubjectRefs = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  [...prefix, 'candidate', 'dossier'], ...finalSubjectRefs([...prefix, 'subject']),
];
const contextData = (prefix: readonly PathPatternSegment[]): PathPattern[] => [
  ...contextBodyData(prefix), ...capacityData([...prefix, 'resultCapacity'])
];

/**
 * Stored contracts whose bodies contain JSON data next to engine references.
 * Everything outside these declared data subtrees keeps the historical
 * structural reference scan. Unknown contracts therefore fail closed instead
 * of silently borrowing the semantics of another era.
 */
const RECORD_REFERENCE_SEMANTICS: readonly RecordReferenceSemantics[] = [
  { kind: "limited-call-retry-permit", contract: "limited-call-retry-permit/v1", data: [], refs: [["call"], ["terminal"], ["consumer"]] },
  { kind: "decision", contract: null, data: [["value"]] },
  { kind: "design", contract: null, data: [["value"]] },
  { kind: "fact", contract: null, data: [["observation", "value"]] },
  { kind: "discovery-draft", contract: null, data: [["fields"]] },
  { kind: "question", contract: null, data: [["spec", "schema"]] },
  { kind: "stage", contract: null, data: [["content", "fields"]] },
  { kind: "research-answer", contract: null, data: [["value"]] },
  // DR2: a v7 answer declares its typed references — the accepted assessment
  // and every claim basis of the discriminated dossier form: a fact basis
  // names basis.source.ref, an inference basis names basis.from[*].container
  // (a single ClaimAddress or an array of them), an owner-decision basis
  // names basis.authority. Free payload content keeps no site even where an
  // object resembles a Ref; old answers without the root marker stay on the
  // contract:null rule above.
  { kind: "research-answer", contract: "discovery-claims/v7", data: [], refs: [
    ["assessment"],
    ["value", "claims", INDEX, "basis", "source", "ref"],
    ["value", "claims", INDEX, "basis", "from", "container"],
    ["value", "claims", INDEX, "basis", "from", INDEX, "container"],
    ["value", "claims", INDEX, "basis", "authority"],
    ["value", "claims", INDEX, "basis", "authority", "ref"],
  ] },
  // DR3a1: a v7 research attempt declares every reference of its contract —
  // draft, accepted plan answer, generating call, a duplicate's original,
  // refused/impossible evidence, and inside the submitted end's claims the
  // same dossier links as the research-answer rule above plus the
  // planQuestions link targets and claim-to-claim ClaimAddress containers.
  { kind: "research-attempt", contract: "v7-attempt/v1", data: [], refs: [
    ["draft"], ["planAnswer"], ["call"],
    ["end", "of"],
    ["end", "evidence", INDEX],
    ["end", "value", "claims", INDEX, "planQuestions", INDEX, "planAnswer"],
    ["end", "value", "claims", INDEX, "scope", "variants", INDEX],
    ["end", "value", "claims", INDEX, "basis", "source", "ref"],
    ["end", "value", "claims", INDEX, "basis", "from", "container"],
    ["end", "value", "claims", INDEX, "basis", "from", INDEX, "container"],
    ["end", "value", "claims", INDEX, "basis", "authority"],
    ["end", "value", "claims", INDEX, "basis", "authority", "ref"],
    ["end", "value", "claims", INDEX, "contradicts", INDEX, "container"],
    ["end", "value", "claims", INDEX, "refutedBy", INDEX, "container"],
    ["end", "value", "claims", INDEX, "supersedes", "container"],
  ] },
  // DR3a3-K: the attempt binding names exactly the original turn, the pending
  // revision it completed, the producing intent, the accepted plan answer of
  // its subject and the recorded attempt — no free data.
  { kind: "research-attempt-binding", contract: "research-attempt-binding/v1", data: [], refs: [
    ["turn"], ["pending"], ["intent"], ["planAnswer"], ["attempt"],
  ] },
  // DR3b-M: the attempts assessment names exactly its packet (plan answer, real Question, each attempt and its K),
  // its baseline (the exact state and every material container), the paid session/application, the environment,
  // the return target and every classified attempt/claim container — reasons and other texts are not references.
  { kind: "discovery-assessment", contract: "discovery-assessment/v1", data: [], refs: [
    ["subject", "packet", "planAnswer"], ["subject", "packet", "question"],
    ["subject", "packet", "entries", INDEX, "attempt"], ["subject", "packet", "entries", INDEX, "binding"],
    ["baseline", "state", "ref"], ["baseline", "materials", INDEX, "container"],
    ["session"], ["application"], ["environment"],
    ["return", "target", "attempt"], ["return", "target", "claim", "container"],
    ["novelty", "attempts", INDEX, "attempt"], ["novelty", "noProgress", INDEX, "attempt"],
    ["novelty", "accepted", INDEX, "claim", "container"], ["novelty", "rejected", INDEX, "claim", "container"],
    ["novelty", "newContent", INDEX, "claim", "container"], ["novelty", "duplicates", INDEX, "claim", "container"],
    ["novelty", "duplicates", INDEX, "of", "container"],
    ["novelty", "transition", "bases", INDEX, "claim", "container"],
    ["novelty", "transition", "bases", INDEX, "constraint"],
  ] },
  // M2: v2 adds only declared methodological links; free reasons are data.
  { kind: "discovery-assessment", contract: "discovery-assessment/v2", data: [], refs: [
    ["subject", "packet", "planAnswer"], ["subject", "packet", "question"],
    ["subject", "packet", "entries", INDEX, "attempt"], ["subject", "packet", "entries", INDEX, "binding"],
    ["baseline", "state", "ref"], ["baseline", "materials", INDEX, "container"],
    ["session"], ["application"], ["environment"],
    ["return", "target", "attempt"], ["return", "target", "claim", "container"],
    ["novelty", "attempts", INDEX, "attempt"], ["novelty", "noProgress", INDEX, "attempt"],
    ["novelty", "accepted", INDEX, "claim", "container"], ["novelty", "rejected", INDEX, "claim", "container"],
    ["novelty", "newContent", INDEX, "claim", "container"], ["novelty", "duplicates", INDEX, "claim", "container"],
    ["novelty", "duplicates", INDEX, "of", "container"],
    ["novelty", "transition", "bases", INDEX, "claim", "container"],
    ["novelty", "transition", "bases", INDEX, "constraint"],
    ["methodology", "facts", INDEX, "claim", "container"],
    ["methodology", "facts", INDEX, "sources", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "original"],
    ["methodology", "facts", INDEX, "sources", INDEX, "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "publicationDate", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "eventDate", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "version", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "temporalApplicability", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "corroboration", "sources", INDEX],
    ["methodology", "facts", INDEX, "refutation", "traces", INDEX, "turn"],
    ["methodology", "facts", INDEX, "refutation", "traces", INDEX, "capture"],
    ["methodology", "facts", INDEX, "refutation", "counterarguments", INDEX, "source"],
  ] },
  // P.3: atomic progress records retain their exact paid and accepted origins.
  { kind: "v7-progress-application", contract: "v7-progress-application/v1", data: [], refs: [
    ["subject", "planAnswer"], ["assessment"], ["previous"], ["prefix", INDEX], ["methodologyOrigins", INDEX, "claim", "container"],
    ["methodologyOrigins", INDEX, "assessment"], ["reused", INDEX], ["priorEvents", INDEX], ["attempts", INDEX],
  ] },
  { kind: "v7-progress-state", contract: "v7-progress-state/v1", data: [], refs: [
    ["subject", "planAnswer"], ["application"],
  ] },
  { kind: "v7-attempt-account", contract: "v7-attempt-account/v1", data: [], refs: [
    ["subject", "planAnswer"], ["application"], ["attempt"], ["accepted", INDEX, "container"],
  ] },
  { kind: "research-progress-event", contract: "research-progress-event/v1", data: [], refs: [
    ["subject", "planAnswer"], ["application"], ["attempt"], ["basis", "claim", "container"], ["basis", "constraint"],
    ["basis", "transition", "bases", INDEX, "claim", "container"], ["basis", "transition", "bases", INDEX, "constraint"],
  ] },
  // MR: explicit paid closing requirements retain their exact claim addresses.
  { kind: "discovery-assessment", contract: "discovery-assessment/v3", data: [], refs: [
    ["subject", "packet", "planAnswer"], ["subject", "packet", "question"],
    ["subject", "packet", "entries", INDEX, "attempt"], ["subject", "packet", "entries", INDEX, "binding"],
    ["baseline", "state", "ref"], ["baseline", "materials", INDEX, "container"],
    ["session"], ["application"], ["environment"],
    ["return", "target", "attempt"], ["return", "target", "claim", "container"],
    ["novelty", "attempts", INDEX, "attempt"], ["novelty", "noProgress", INDEX, "attempt"],
    ["novelty", "accepted", INDEX, "claim", "container"], ["novelty", "rejected", INDEX, "claim", "container"],
    ["novelty", "newContent", INDEX, "claim", "container"], ["novelty", "duplicates", INDEX, "claim", "container"],
    ["novelty", "duplicates", INDEX, "of", "container"],
    ["novelty", "transition", "bases", INDEX, "claim", "container"],
    ["novelty", "transition", "bases", INDEX, "constraint"],
    ["novelty", "transition", "sufficiency", "methodologyRequirements", INDEX, "claim", "container"],
    ["methodology", "facts", INDEX, "claim", "container"],
    ["methodology", "facts", INDEX, "sources", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "original"],
    ["methodology", "facts", INDEX, "sources", INDEX, "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "publicationDate", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "eventDate", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "sources", INDEX, "version", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "temporalApplicability", "evidence", INDEX, "source"],
    ["methodology", "facts", INDEX, "corroboration", "sources", INDEX],
    ["methodology", "facts", INDEX, "refutation", "traces", INDEX, "turn"],
    ["methodology", "facts", INDEX, "refutation", "traces", INDEX, "capture"],
    ["methodology", "facts", INDEX, "refutation", "counterarguments", INDEX, "source"],
  ] },
  { kind: "research-assessment", contract: null, data: [["value"], ["observations", INDEX, "value"]] },
  { kind: "research-checkpoint", contract: null, data: [["proposal"], ["observations", INDEX, "value"]] },
  { kind: "research-context", contract: null, data: contextData(["body"]) },
  { kind: "research-context", contract: "result-capacity-projection/v1", data: contextBodyData(["body", "subject"]) },
  { kind: "reader-result", contract: "reader-result/v2", data: [["observations", INDEX, "value"]] },
  { kind: "pilot-reading", contract: null, data: [["observation", "value"]] },
  { kind: "research-turn", contract: "research-consumer-turn/v1", data: [
    ...researchActionData(["action"]), ...observationData(["observation"]),
  ] },
  { kind: "research-consumer-intent", contract: "research-consumer-intent/v1", data: [...contextData(["cursor", "context"]), ...capacityData(["cursor", "resultCapacity"])] },
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
  // DR3a3-S1: the v3 session keeps the v2 data subtrees (proposals, notes,
  // results and pauses are model data); its binding, materials' sources and
  // binding.subject.planAnswer remain engine references of the structural scan.
  { kind: "synthesis-session", contract: "synthesis-session/v3", data: synthesisSessionData() },
  // DR3a3-S1: the v2 partial note — the proposal and observed values are data;
  // draft, question, subject.planAnswer and observation sources are references.
  { kind: "research-checkpoint", contract: "research-checkpoint/v2", data: [["proposal"], ["observations", INDEX, "value"]] },
  // DR3a3-S1: the saved-only selection of one subject names exactly these refs.
  { kind: "saved-synthesis", contract: "saved-synthesis/v2", data: [], refs: [
    ["draft"], ["question"], ["inputs", INDEX], ["subject", "planAnswer"], ["checkpoints", INDEX],
  ] },
  { kind: "web-capture", contract: "web-capture/v1", data: [["response"]] },
  { kind: "web-capture", contract: "web-capture/v2", data: [["response"]] },
  { kind: "web-capture", contract: "web-capture/v3", data: [["response"]],
    refs: [["turn"], ["environment"], ["material", "reservation"], ["budget"]] },
  { kind: "web-admissions", contract: "web-admissions/v1", data: [],
    refs: [["pending", INDEX, "turn"], ["pending", INDEX, "environment"]] },
  { kind: "web-budget", contract: "web-budget/v2", data: [],
    refs: [["migratedFrom"], ["charges", INDEX, "capture"], ["reservations", INDEX, "turn"],
      ["reservations", INDEX, "environment"]] },
  { kind: "om-integrity", contract: "om-integrity/v1", data: [["findings", INDEX, "ref"]] },
  { kind: "question-packet", contract: null, data: [
    ["packet", "correction", "answer", "value"],
    ["packet", "correction", "answer", "text"],
    ["packet", "sourceDeliveries", INDEX, "data", INDEX, "data", "value"],
    ["packet", "sourceDeliveries", INDEX, "data", INDEX, "data", "text"],
    ["packet", "sourceDeliveries", INDEX, "data", "value"],
    ["packet", "sourceDeliveries", INDEX, "data", "text"],
    ["packet", "materialDelivery", INDEX, "value"],
    ["packet", "materialDelivery", INDEX, "text"],
    ["packet", "expansion", "previous", INDEX, "nodes"],
    ["packet", "expansion", "previous", INDEX, "tests"],
    ["packet", "expansion", "previous", INDEX, "edges"],
    ["packet", "expansion", "reopenedFiles", INDEX, "content"],
  ] },
  { kind: "om-read-delivery", contract: null, data: [["data", "value"], ["data", "text"]] },
  { kind: "om-capacity-recovery", contract: "om-capacity-recovery/v1", data: [["delivery", "value"], ["delivery", "text"]] },
  { kind: "om-limited-call-retry-permit", contract: "om-limited-call-retry-permit/v1", data: [] },
  { kind: "request-manifest", contract: "request-manifest/v1", data: [["wire"]], refs: [["parts", INDEX], ["intent"], ["call"]] },
  { kind: "request-part", contract: "request-part/v1", data: [["text"]], refs: [] },
  // DRS1a2: the immutable preparation of an analyst call names its step and its
  // exact parts; the compact archive names its metadata and parts; neither has
  // free data (the JSON lives inside the parts, whose text is data).
  { kind: "context-preparation", contract: "context-preparation/v1", data: [],
    refs: [["draft"], ["question"], ["owner"], ["subject", "planAnswer"], ["graphBase"], ["parts", INDEX]] },
  { kind: "research-context", contract: "archive-parts/v1", data: [],
    refs: [["draft"], ["question"], ["subject", "planAnswer"], ["parts", INDEX]] },
  // DRS1a2: the v2 intent is the v1 form without cursor.context — every other
  // field keeps the structural scan (preparation, guards, subject, capacity data).
  { kind: "research-consumer-intent", contract: "research-consumer-intent/v2", data: capacityData(["cursor", "resultCapacity"]) },
  // D6 publication keeps its exact producer/paid anchors. The full projected
  // packet and model judgments are data; the anchors retain their source graph.
  { kind: "discovery-dossier-assessment", contract: "discovery-dossier-assessment/v1", data: [], refs: [
    ["subject", "root", "ref"], ["subject", "manifest"], ["manifest"], ["session"], ["application"],
    ["call"], ["request"], ["response"]] },
  // The paid D7 cursor is distinct from its immutable preparation. Projected
  // bundle and workspace values remain data, while their exact sources are links.
  { kind: "discovery-final-execution", contract: "discovery-final-execution/v1", data: [], refs: [
    ["prepared"], ...finalSubjectRefs(["subject"]), ["binding", "draft"], ["binding", "question"],
    ["binding", "environment"], ["binding", "inputs", INDEX], ["profile"], ["previous"], ["result"],
    ["workspace", "entries", INDEX, "result", "record"], ["workspace", "deliveryCoverage", INDEX, "record"]] },
  { kind: "discovery-final-application", contract: "discovery-final-application/v1", data: [], refs: [
    ["session"], ["profile"], ["guards", INDEX], ["call"], ["received"], ["after"],
    ["context", "finalContinuation", "prepared"], ["context", "finalContinuation", "execution"],
    ...finalSubjectRefs(["context", "finalContinuation", "subject"]),
    ["context", "resultCapacity", "mandatory", "archive", "record"],
    ["context", "contextWorkspace", INDEX, "record"]] },
  { kind: "discovery-final-paid-result", contract: "discovery-final-paid-result/v1", data: [], refs: [
    ["prepared"], ...finalSubjectRefs(["subject"]), ["session"], ["application"], ["call"], ["request"], ["response"]] },
  // Final assessment binds a paid D7 source and the whole candidate, but
  // conditional user payload and projected packet are data, not new anchors.
  { kind: "discovery-final-assessment-execution", contract: "discovery-final-assessment-execution/v1", data: [], refs: [
    ["source"], ["prepared"], ...finalAssessmentSubjectRefs(["subject"]), ["binding", "draft"], ["binding", "question"],
    ["binding", "environment"], ["binding", "inputs", INDEX], ["profile"], ["previous"], ["result"],
    ["workspace", "entries", INDEX, "result", "record"], ["workspace", "deliveryCoverage", INDEX, "record"]] },
  { kind: "discovery-final-assessment-application", contract: "discovery-final-assessment-application/v1", data: [], refs: [
    ["session"], ["profile"], ["guards", INDEX], ["call"], ["received"], ["after"],
    ["context", "finalContinuation", "source"], ["context", "finalContinuation", "prepared"],
    ["context", "finalContinuation", "execution"], ...finalAssessmentSubjectRefs(["context", "finalContinuation", "subject"]),
    ["context", "resultCapacity", "mandatory", "archive", "record"], ["context", "contextWorkspace", INDEX, "record"]] },
  { kind: "discovery-final-assessment-paid-result", contract: "discovery-final-assessment-paid-result/v1", data: [], refs: [
    ["source"], ["prepared"], ...finalAssessmentSubjectRefs(["subject"]), ["session"], ["application"], ["call"], ["request"], ["response"]] },
  { kind: "model-call", contract: null, data: [["finalContinuation", "subject", "candidate", "verdict", "conditions"]] },
  { kind: "continuation-state", contract: null, data: [["finalContinuation", "subject", "candidate", "verdict", "conditions"]] },
  // DR6 6.1/6.2: the structural dossier snapshot declares its exact references only — the draft, the accepted frame
  // and plan answers, the grounds of each partial reason, every claim container of the axes, unknowns and
  // contradiction sides, the assessment of each side and the grounds of each resolution.
  // Texts are data; the record proves no paid producer, accepted claim or acceptance.
  { kind: "discovery-dossier-manifest", contract: "discovery-dossier-manifest/v1", data: [], refs: [
    ["draft"], ["frame"], ["plan"], ["reasons", INDEX, "grounds", INDEX],
    ["axes", KEY, "claims", INDEX, "container"], ["unknowns", INDEX, "claim", "container"],
    ["contradictions", INDEX, "sides", INDEX, "claim", "container"], ["contradictions", INDEX, "sides", INDEX, "assessment"],
    ["contradictions", INDEX, "resolution", "grounds", INDEX]] },
  { kind: "discovery-selected-dossier", contract: "discovery-selected-dossier/v1", data: [], refs: [
    ["draft"], ["frame"], ["plan"], ["scope"], ["set"], ["member"], ["decision"], ["manifest"], ["boundary", "record"],
    ["inventory", "attempts", INDEX], ["inventory", "assessments", INDEX], ["inventory", "applications", INDEX],
    ["inventory", "states", INDEX], ["inventory", "accounts", INDEX]] },
  // DR2b 2b.1-F: the interpretations set declares its exact grounds and links only — the brief source, the
  // frame proposal revision and the previous set; meanings, consequences and support selectors are data.
  { kind: "frame-interpretations", contract: "frame-interpretations/v1", data: [], refs: [
    ["brief", "source"], ["frame"], ["previousSet"]] },
  // DR2b 2b-GEN: the prepared generation session names exactly its bound grounds — the mandate Source,
  // the frame revision, the previous set, the request archive and the exact environment revision. The
  // request, the preparation parameters, the saved envelope and the initial cursor are verified data —
  // the session proves no paid call, choice or result.
  { kind: "frame-interpretation-session", contract: "frame-interpretation-session/v1", data: [
    ["request"], ["input"], ["envelope"], ["cursor"], ["brief", "selector"]], refs: [
    ["brief", "source"], ["frame"], ["previousSet"], ["archive"], ["environment"]] },
  // DR5 5.1-F: the coverage cell names exactly its plan answer and its exact variant set and member — the
  // plan-question id, depth and criterion are data; the cell confirms no coverage.
  { kind: "discovery-coverage-cell", contract: "discovery-coverage-cell/v1", data: [], refs: [
    ["subject", "planAnswer"], ["variant", "set"], ["variant", "member"]] },
  // DR5 5.2-F: the deep preparation names exactly the references of its cell and its exact variant scope —
  // the cell texts are data; the preparation permits no dispatch.
  { kind: "discovery-deep-preparation", contract: "discovery-deep-preparation/v1", data: [], refs: [
    ["cell", "subject", "planAnswer"], ["cell", "variant", "set"], ["cell", "variant", "member"], ["scope"]] },
  // DR7 7b.2-F: the manifest of the final bundle names exactly its draft, bundle, assessment, admission record,
  // previous manifest and condition resolution records; the admission kind is data and proves no authority.
  { kind: "discovery-manifest", contract: "discovery-manifest/v7", data: [], refs: [
    ["draft"], ["bundle"], ["assessment"], ["admission", "record"], ["previous"], ["resolutions", INDEX]] },
  // DR7 7b.1+7b.2: the owner act, the machine admission and the saved whole bundle of one accepted D7. The bundle body and
  // the scope texts are data; the act names its exact draft, paid D7, assessment, mode record and authority records.
  { kind: "discovery-final-acceptance-act", contract: "discovery-final-acceptance-act/v1", data: [], refs: [
    ["scope", "draft"], ["scope", "paid"], ["scope", "assessment"], ["scope", "mode"], ["authority", "grant"], ["authority", "session"]] },
  { kind: "discovery-final-machine-admission", contract: "discovery-final-machine-admission/v1", data: [], refs: [
    ["draft"], ["paid"], ["assessment"], ["mode"]] },
  { kind: "discovery-final-bundle", contract: "discovery-final-bundle/v1", data: [["bundle"]], refs: [["paid"]] },
  // DR7 7b.3: the owner act on one condition of a saved bundle. The option texts are data; the act names its edition,
  // its bundle and its authority records.
  { kind: "discovery-condition-resolution", contract: "discovery-condition-resolution/v1", data: [], refs: [
    ["predecessor"], ["bundle"], ["scope", "predecessor"], ["scope", "bundle"], ["authority", "grant"], ["authority", "session"]] },
  // DR4-M: structural reference sites only. These records do not prove paid or owner provenance.
  { kind: "discovery-variant-snapshot", contract: "discovery-variant-snapshot/v1", data: [], refs: [
    ["draft"], ["frame"], ["plan"], ["questions", INDEX, "question"], ["questions", INDEX, "progress"],
    ["questions", INDEX, "applications", INDEX], ["questions", INDEX, "reason", "grounds", INDEX]] },
  { kind: "discovery-variant", contract: "discovery-variant/v1", data: [["proposal"]], refs: [
    ["draft"], ["snapshot"], ["origin", "intent"], ["origin", "call"], ["origin", "response"],
    ["criteria", KEY, "grounds", INDEX], ["criteria", KEY, "quantity", "grounds", INDEX]] },
  { kind: "discovery-variant-set", contract: "discovery-variant-set/v1", data: [], refs: [
    ["draft"], ["snapshot"], ["origin", "intent"], ["origin", "call"], ["origin", "response"],
    ["members", INDEX], ["recommendation", "member"]] },
  { kind: "discovery-variant-none", contract: "discovery-variant-none/v1", data: [], refs: [
    ["draft"], ["snapshot"], ["origin", "intent"], ["origin", "call"], ["origin", "response"], ["reasons", INDEX, "grounds", INDEX]] },
  { kind: "discovery-variant-owner-decision", contract: "discovery-variant-owner-decision/v1", data: [], refs: [
    ["draft"], ["set"], ["mode"], ["expectedSelection"], ["previous"], ["outcome", "member"], ["authority", "grant"], ["authority", "session"]] },
  { kind: "discovery-variant-model-decision", contract: "discovery-variant-model-decision/v1", data: [], refs: [
    ["draft"], ["set"], ["mode"], ["expectedSelection"], ["previous"], ["outcome", "member"],
    ["origin", "intent"], ["origin", "call"], ["origin", "response"]] },
  { kind: "discovery-variant-state", contract: "discovery-variant-state/v1", data: [], refs: [
    ["draft"], ["mode"], ["result"], ["set"], ["decision"], ["previous"]] },
  { kind: "discovery-variant-scope", contract: "discovery-variant-scope/v1", data: [], refs: [
    ["draft"], ["set"], ["member"], ["decision"], ["mode"]] },
  { kind: "discovery-variant-handoff", contract: "discovery-variant-handoff/v1", data: [], refs: [
    ["draft"], ["frame"], ["plan"], ["snapshot"], ["result"], ["set"], ["decision"], ["scope"], ["choice"], ["stop", "grounds", INDEX]] },
  { kind: "om-answer-closure", contract: "om-answer-closure/v1", data: [],
    refs: [["answer"], ["guards", INDEX], ["external", INDEX, "ref"], ["references", INDEX]] },
  { kind: "discovery-acceptance-act", contract: "discovery-acceptance-act/v1", data: [],
    refs: [["draftBefore"], ["draftAfter"], ["questionBefore"], ["questionAfter"], ["answer"], ["assessment"], ["binding"]] },
  // G4a: the prefix closure names every head it stands on — the draft, inputs, derivation sources,
  // each question's head and answer chain, every observation source and runtime dependency, and the
  // declared external checks (a source check names `ref`; the other union kinds name `basis`).
  // The stored answer `value` is payload snapshot material, not a reference. A managed entry's
  // saved read set declares the proof's heads and every pinned exact revision — its absent
  // declarations carry no hash and name nothing to traverse.
  { kind: "discovery-prefix-closure", contract: "discovery-prefix-closure/v1",
    data: [["questions", INDEX, "answer", "value"]], refs: [
    ["draft"], ["inputs", INDEX], ["derivations", INDEX], ["questions", INDEX, "question"],
    ["questions", INDEX, "answer", "answer"], ["questions", INDEX, "answer", "assessment"],
    ["questions", INDEX, "answer", "binding"], ["questions", INDEX, "answer", "act"],
    ["questions", INDEX, "answer", "sources", INDEX], ["questions", INDEX, "answer", "runtimeDependencies", INDEX],
    ["questions", INDEX, "answer", "managed", "heads", INDEX],
    ["questions", INDEX, "answer", "managed", "pinned", INDEX],
    ["external", INDEX, "ref"], ["external", INDEX, "basis"]] },
  // DR9 9.1-F: the keeper check key names exactly the container records of its two addresses — the
  // pointers, the project and the check version are data; no other Ref-like value is a reference.
  { kind: "keeper-check-key", contract: "keeper-check-key/v1", data: [], refs: [
    ["artifact", "container"], ["constitution", "container"]] },
];

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReference = (value: Record<string, unknown>): value is Record<string, unknown> & StoredReference =>
  typeof value["id"] === "string" && Number.isSafeInteger(value["revision"]) && Number(value["revision"]) > 0
  && typeof value["hash"] === "string" && HASH.test(value["hash"] as string);

/** Gateway method JSON remains data when copied from a captured document into a Source or its inventory row. */
function webMethodOwner(value: Record<string, unknown>): boolean {
  if (value["kind"] === "web" && value["documentContract"] === "web-document/v2")
    return object(value["capture"]) && isReference(value["capture"]);
  return value["kind"] === "web" && value["media"] === "text/markdown"
    && object(value["ref"]) && isReference(value["ref"])
    && typeof value["ref"].id === "string" && value["ref"].id.startsWith("source:")
    && typeof value["structureHash"] === "string" && HASH.test(value["structureHash"])
    && object(value["toc"]) && (value["toc"].contract === "source-toc/v1"
      || value["toc"].contract === "source-toc-page/v1");
}

function sourceTableMethodIndex(value: Record<string, unknown>): number {
  if (!Array.isArray(value["columns"]) || !Array.isArray(value["rows"])) return -1;
  const columns = value["columns"];
  if (!columns.every(column => typeof column === "string") || new Set(columns).size !== columns.length)
    return -1;
  return columns.indexOf("method");
}

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
  const declared = RECORD_REFERENCE_SEMANTICS.find(rule => rule.kind === kind && rule.contract === contract)?.refs;
  const sites: ReferenceSite[] = [];
  const visit = (current: unknown, path: PathSegment[]): void => {
    if (data.some(pattern => matches(pattern, path))) return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!object(current)) return;
    if (isReference(current)) {
      if (!declared || declared.some(pattern => matches(pattern, path))) sites.push({ field: shown(path), ref: current });
      return;
    }
    const methodIndex = sourceTableMethodIndex(current);
    if (methodIndex >= 0) {
      const columns = current["columns"] as string[];
      const rows = current["rows"] as unknown[][];
      for (const [rowIndex, row] of rows.entries()) {
        if (!Array.isArray(row) || row.length !== columns.length) {
          visit(row, [...path, "rows", rowIndex]);
          continue;
        }
        const entry = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
        row.forEach((cell, index) => {
          if (index !== methodIndex || !webMethodOwner(entry))
            visit(cell, [...path, "rows", rowIndex, index]);
        });
      }
      for (const [key, item] of Object.entries(current)) if (key !== "rows") visit(item, [...path, key]);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key === "method" && webMethodOwner(current)) continue;
      visit(item, [...path, key]);
    }
  };
  visit(value, []);
  return sites;
}

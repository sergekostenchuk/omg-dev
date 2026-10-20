import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../src/canonical.js";
import { Evidence } from "../src/evidence/evidence.js";
import { ProductEngine } from "../src/product/engine.js";
import { git, uniqueTransactionGuards } from "../src/runtime/environment.js";
import { readResearchConsumerIntent, researchConsumerIntentId } from "../src/discovery/response-recovery.js";
import { configureReaderPilot, pilotEnvironment } from "../src/discovery/reader-pilot.js";
import { pilotContext, readPilotContext, retainPilotRead } from "../src/discovery/pilot-context.js";
import { synthesisSession } from "../src/discovery/synthesis-session.js";
import { workingContext } from "../src/discovery/working-context.js";
import { preparedFeatures } from "./product-fixture.js";
import { reference } from "../src/pipeline/contracts.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { Store } from "../src/storage/store.js";
import { checkStoreIntegrity } from "../src/storage/fsck.js";
import { integrityGate, integrityId, runIntegrityCheck, type IntegrityRecord } from "../src/om/integrity.js";
import { continuePass, startPass } from "../src/om/run-driver.js";

/**
 * NR1 (№3633, №3646): om-fsck, as in git. A change made to the database by anyone but the engine — another connection
 * writing raw SQL — is found by the whole check at its exact address: a body that is not the one its sha256 was written
 * for, a revision rewritten with its sha256 while another record still names the old hash, a revision or event gone, a
 * head moved. The check runs by itself at om-start and om-continue: damage found stops the pass with the addresses.
 */
const PROJECT = "garden";
const TRIGGERS = ["revisions_no_update", "revisions_no_delete", "events_no_update", "events_no_delete"];

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "omg-fsck-"));
  const path = join(root, "store.sqlite");
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const [a] = store.writeMany([{ id: "note:garden:a", kind: "note", expected: 0, value: { text: "first" } }]);
  const [b] = store.writeMany([{ id: "note:garden:b", kind: "note", expected: 0, value: { names: [reference(a!)] } }]);
  const [a2] = store.writeMany([{ id: "note:garden:a", kind: "note", expected: 1, value: { text: "second" } }]);
  return {
    path, store, a: a!, b: b!, a2: a2!,
    /** A change as someone other than the engine makes it: another connection, raw SQL, the immutability triggers dropped. */
    foreign(sql: string, ...values: (string | number)[]) {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=OFF");
      for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.prepare(sql).run(...values);
      db.close();
    },
  };
}
const found = (store: Store) => checkStoreIntegrity(store).findings.map(finding => `${finding.code}:${finding.id}@${finding.revision}`).sort();
const REF_SHAPED_DATA = { id: "fixture-plan", revision: 1, hash: "0".repeat(64) };
const refusedAs = (result: { ok: boolean; refusal?: { code: string; message: string; route?: string } } | null, code: string, includes?: string) => {
  assert.ok(result && !result.ok, `Expected ${code}`);
  assert.equal(result.refusal!.code, code);
  if (includes) assert.ok(result.refusal!.message.includes(includes), result.refusal!.message);
};

test("om-fsck reference sites: stored producer semantics keep engine refs and treat nested candidate JSON as data", () => {
  const source = { id: "source:garden:values", revision: 2, hash: "a".repeat(64) };
  const question = { id: "question:garden:q", revision: 3, hash: "b".repeat(64) };
  const observation = { projectId: PROJECT, source, selector: { kind: "json-pointer", pointer: "/payload" },
    value: { families: [{ candidate: REF_SHAPED_DATA }] } };
  const assessmentSession = { projectId: PROJECT, contract: "assessment-application/v1",
    application: "assessment-application:fixture", binding: { draft: source, question, environment: source, inputs: [source] },
    workspace: { entries: [{ key: "lookup", result: { record: question, pointer: "/payload",
      value: { nested: REF_SHAPED_DATA } } }], sinceProgress: 1 },
    notes: [{ packet: question, response: { action: "assessment_checkpoint", notes: ["candidate resembles a ref"] } }],
    result: { verdict: "supported", reasons: [] } };
  const savedFinding = { kind: "saved-findings", value: { checkpoint: question,
    proposal: { nested: REF_SHAPED_DATA }, unresolved: [],
    evidence: [{ source, selector: { kind: "json-pointer", pointer: "/payload" },
      original: { record: question, pointer: "/observations/0" } }] } };
  const synthesisSession = { projectId: PROJECT, contract: "synthesis-session/v2",
    binding: { draft: source, question, environment: source, inputs: [source] },
    basis: { materials: [{ kind: "context", value: observation }, savedFinding], previousProposal: { action: "answer",
      question: question.id, value: { nested: REF_SHAPED_DATA }, citations: [{ source }] }, previousProposalRef: question },
    workspace: { entries: [{ key: "lookup", result: { record: question, pointer: "/payload",
      value: { nested: REF_SHAPED_DATA } } }], sinceProgress: 1 },
    notes: [{ checkpoint: question, proposal: { action: "checkpoint", question: question.id,
      value: { nested: REF_SHAPED_DATA }, citations: [{ source }], unresolved: [] }, page: { offset: 0, end: 1 } }],
    result: { action: "answer", question: question.id, value: { nested: REF_SHAPED_DATA }, citations: [{ source }] } };
  const planAnswer = { id: "research-answer:garden:plan", revision: 2, hash: "c".repeat(64) };
  const synthesisSessionV3 = { ...synthesisSession, contract: "synthesis-session/v3",
    binding: { ...synthesisSession.binding, subject: { contract: "v7-plan-subject/v1", planAnswer, planQuestionId: "q-supply" } } };
  const copiedContext = {
    observations: [observation], value: { nested: REF_SHAPED_DATA },
    currentProposal: { nested: REF_SHAPED_DATA }, priorEvidence: [observation],
    core: { initial: source, concept: question, specification: source, features: question,
      brief: { nested: REF_SHAPED_DATA }, objective: { nested: REF_SHAPED_DATA },
      actors: [{ nested: REF_SHAPED_DATA }], requirements: [{ nested: REF_SHAPED_DATA }] },
    history: [{ question, assessment: source,
      action: { action: "answer", question: question.id, value: { nested: REF_SHAPED_DATA }, citations: [{ source }] },
      observation: { requested: { record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } } } }],
    currentRead: { question, action: { action: "checkpoint", question: question.id,
      value: { nested: REF_SHAPED_DATA }, citations: [{ source }], unresolved: [] },
      observation: { observations: [observation] } },
    assessmentNotes: [{ packet: question, response: { action: "assessment_checkpoint", notes: [REF_SHAPED_DATA] } }],
    synthesisNotes: [{ checkpoint: question, proposal: { action: "checkpoint", question: question.id,
      value: { nested: REF_SHAPED_DATA }, citations: [{ source }], unresolved: [] } }],
    candidate: { current: { record: question, pointer: "/body/value" }, previous: source,
      changes: [{ pointer: "/nested", value: REF_SHAPED_DATA }] },
    proposalChanges: { current: { record: question, pointer: "/body/previousProposal" }, base: source,
      changes: [{ pointer: "/nested", value: REF_SHAPED_DATA }] },
    conclusions: [{ literal: { nested: REF_SHAPED_DATA } }], conclusionRefs: [REF_SHAPED_DATA],
  };
  const samples = [
    { name: "research-assessment", kind: "research-assessment", value: { question, environment: source, observations: [observation],
      value: { nested: [REF_SHAPED_DATA] } } },
    { name: "assessment-application", kind: "assessment-application", value: { contract: "assessment-application/v1", session: question,
      context: { ...copiedContext,
        stageNeighbors: { fields: [{ question, answer: source, value: { nested: REF_SHAPED_DATA } }] },
        contextWorkspace: [{ record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } }],
        workingSelections: [{ kind: "context", value: { record: question, pointer: "/payload",
          value: { nested: REF_SHAPED_DATA } } }],
        previousProposal: { action: "answer", question: question.id, value: { nested: REF_SHAPED_DATA },
          citations: [{ source, selector: { kind: "json-pointer", pointer: "/payload" } }] } } } },
    { name: "assessment-paid-origin", kind: "assessment-paid-origin", value: { contract: "assessment-paid-origin/v1", pending: question,
      context: { selectedContext: [{ record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } }] },
      runtime: { proofs: [], supporting: [observation], guards: [source], admissionGuards: [] } } },
    { name: "assessment-session/current", kind: "assessment-session", value: assessmentSession },
    { name: "assessment-session/legacy", kind: "assessment-session",
      value: Object.fromEntries(Object.entries(assessmentSession).filter(([key]) => key !== "contract" && key !== "application")) },
    { name: "synthesis-session/current", kind: "synthesis-session", value: synthesisSession },
    // DR3a3-S1: the v3 session of one plan-question — the same data subtrees as v2, plus its subject.
    { name: "synthesis-session/v3", kind: "synthesis-session", value: synthesisSessionV3 },
    { name: "synthesis-session/legacy", kind: "synthesis-session",
      value: Object.fromEntries(Object.entries(synthesisSession).filter(([key]) => key !== "contract" && key !== "basis" && key !== "binding")) },
    { name: "research-context", kind: "research-context", value: { draft: source, question, body: { ...copiedContext,
      directReadings: [{ observation: { record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } } }],
      savedMaterials: [savedFinding], synthesisMaterials: [savedFinding],
      fields: { proposal: { nested: REF_SHAPED_DATA } }, prerequisites: [{ ref: source, fields: { nested: REF_SHAPED_DATA } }] } } },
    { name: "research-consumer-intent", kind: "research-consumer-intent", value: {
      contract: "research-consumer-intent/v1", owner: question, draft: source, question,
      cursor: { context: { ...copiedContext, directReadings: [{ observation: { record: question, pointer: "/payload",
        value: { nested: REF_SHAPED_DATA } } }], synthesisMaterials: [savedFinding] } } } },
    { name: "pilot-reading", kind: "pilot-reading", value: { projectId: PROJECT, question: question.id,
      action: { action: "read_context", record: question, pointer: "/payload" },
      observation: { record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } } } },
    { name: "research-turn", kind: "research-turn", value: { contract: "research-consumer-turn/v1", question,
      action: { action: "answer", value: { nested: REF_SHAPED_DATA }, citations: [{ source }] },
      observation: { requested: { record: question, pointer: "/payload", value: { nested: REF_SHAPED_DATA } } } } },
    { name: "web-capture", kind: "web-capture", value: { contract: "web-capture/v1", environment: source, turn: question,
      response: { kind: "search", reply: { results: [REF_SHAPED_DATA] } } } },
    { name: "model-response/string", kind: "model-response", value: { projectId: PROJECT,
      text: JSON.stringify({ research: { action: "answer", value: REF_SHAPED_DATA } }) } },
  ];
  for (const sample of samples) {
    const sites = referenceSites(sample.kind, sample.value);
    assert.equal(sites.some(site => site.ref.id === REF_SHAPED_DATA.id), false, `${sample.name} leaked data as a reference`);
    if (sample.name !== "model-response/string")
      assert.ok(sites.some(site => site.ref.id === source.id || site.ref.id === question.id), `${sample.name} lost its declared references`);
    if (sample.name === "assessment-application")
      assert.ok(sites.some(site => site.field === "context.previousProposal.citations[0].source"),
        "A copied proposal keeps its declared citation outside the opaque model value");
  }
  const copiedSites = referenceSites("research-context", { draft: source, question, body: copiedContext });
  for (const field of ["body.core.initial", "body.core.concept", "body.history[0].question",
    "body.history[0].assessment", "body.history[0].action.citations[0].source", "body.currentRead.question",
    "body.currentRead.action.citations[0].source", "body.assessmentNotes[0].packet",
    "body.synthesisNotes[0].checkpoint", "body.synthesisNotes[0].proposal.citations[0].source",
    "body.candidate.current.record", "body.candidate.previous", "body.proposalChanges.current.record",
    "body.proposalChanges.base"])
    assert.ok(copiedSites.some(site => site.field === field), `The copied context lost ${field}`);
  assert.deepEqual(referenceSites("research-assessment", { observations: [{ source: REF_SHAPED_DATA,
    value: { nested: REF_SHAPED_DATA } }] }), [{ field: "observations[0].source", ref: REF_SHAPED_DATA }],
  "A missing declared source remains visible on the pure scan input");
  assert.deepEqual(referenceSites("web-capture", { response: REF_SHAPED_DATA }),
    [{ field: "response", ref: REF_SHAPED_DATA }],
    "A missing or unknown saved contract fails closed instead of borrowing current opaque fields");
  assert.ok(referenceSites("assessment-session", assessmentSession)
    .some(site => site.field === "workspace.entries[0].result.record" && site.ref.id === question.id));
  assert.ok(referenceSites("synthesis-session", synthesisSession)
    .some(site => site.field === "basis.materials[0].value.source" && site.ref.id === source.id));
  assert.ok(referenceSites("synthesis-session", synthesisSession)
    .some(site => site.field === "basis.materials[1].value.evidence[0].source" && site.ref.id === source.id));
  assert.ok(referenceSites("assessment-session", { ...assessmentSession, contract: "assessment-application/v2" })
    .some(site => site.ref.id === REF_SHAPED_DATA.id), "An unknown assessment era fails closed");
  // DR3a3-S1: synthesis-session/v3 is a declared era now; the unknown-era
  // check keeps failing closed on a discriminator no producer writes.
  assert.ok(referenceSites("synthesis-session", { ...synthesisSession, contract: "synthesis-session/v9-unknown" })
    .some(site => site.ref.id === REF_SHAPED_DATA.id), "An unknown session era fails closed");
  const v3Sites = referenceSites("synthesis-session", synthesisSessionV3);
  assert.ok(v3Sites.some(site => site.field === "binding.subject.planAnswer" && site.ref.id === planAnswer.id),
    "The v3 session subject names its exact plan answer as an engine reference");
  assert.ok(v3Sites.some(site => site.field === "basis.materials[0].value.source" && site.ref.id === source.id)
    && v3Sites.some(site => site.field === "basis.materials[1].value.evidence[0].source" && site.ref.id === source.id),
  "The v3 session keeps the material sources of the v2 era");
});

test("om-fsck: lawful JSON observations and an old integrity diagnostic remain data across a reopened store", t => {
  const f = fixture(t), evidence = new Evidence(f.store);
  const source = evidence.document(PROJECT, "values", JSON.stringify({ payload: { nested: [REF_SHAPED_DATA] } }), "application/json", 0);
  const observation = evidence.observe(PROJECT, reference(source), { kind: "json-pointer", pointer: "/payload" });
  const context = { observations: [observation], value: observation.value,
    stageNeighbors: { fields: [{ field: "proposal", question: reference(source), answer: reference(source), value: observation.value }] } };
  f.store.writeMany([
    { id: "research-assessment:json-data", kind: "research-assessment", expected: 0,
      value: { projectId: PROJECT, question: reference(source), environment: reference(source), observations: [observation],
        value: observation.value, verdict: "supported", reasons: [], researcher: "analyst", assessor: "assessor" } },
    { id: "assessment-application:json-data", kind: "assessment-application", expected: 0,
      value: { contract: "assessment-application/v1", projectId: PROJECT, session: reference(source), context } },
    { id: "assessment-paid-origin:json-data", kind: "assessment-paid-origin", expected: 0,
      value: { contract: "assessment-paid-origin/v1", projectId: PROJECT, pending: reference(source), context } },
    { id: "research-context:json-data", kind: "research-context", expected: 0,
      value: { projectId: PROJECT, draft: reference(source), question: reference(source), body: context } },
    { id: integrityId(PROJECT), kind: "om-integrity", expected: 0,
      value: { contract: "om-integrity/v1", project: PROJECT, checkedAt: 1, lastSequence: 1, revisions: 1, events: 1, references: 1,
        findings: [{ code: "reference_missing", id: "research-context:json-data", revision: 1,
          field: "body.observations[0].value.nested[0]", ref: REF_SHAPED_DATA, message: "Old shape-only diagnostic" }] } },
  ]);
  assert.deepEqual(checkStoreIntegrity(f.store).findings, []);
  assert.equal(integrityGate(f.store, PROJECT), null);
  const reopened = new Store(f.path);
  t.after(() => reopened.close());
  assert.deepEqual(checkStoreIntegrity(reopened).findings, [], "A restart classifies the saved contracts identically");
  const saved = runIntegrityCheck(reopened, { project: PROJECT });
  assert.ok(saved.ok);
  assert.deepEqual(saved.value.value.findings, [], "The new scan supersedes, without rewriting, the old false diagnostic");
});

test("om-fsck: a real synthesis session preserves JSON material as data and its source/binding as references", async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-fsck-synthesis-")), database = join(root, "state.sqlite");
  const workspace = join(root, "repo"), adapter = join(root, "adapter.mjs"), project = "synthesis-json";
  mkdirSync(workspace); git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "fixture\n");
  git(workspace, ["add", "."]); git(workspace, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  writeFileSync(adapter, `import{readFileSync}from'node:fs';const r=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,research:{action:'pause',reason:'fixture pause'},usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,reasoningOutputTokens:0}}));`);
  const store = new Store(database), engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  preparedFeatures(engine, project);
  const command = { executable: process.execPath, args: [adapter] };
  const environment = engine.environments.configure(project, { workspace,
    implementer: { actor: "author", model: "fixture", effort: "high", command },
    reviewer: { actor: "assessor", model: "fixture", effort: "high", command },
    fullCheck: { executable: process.execPath, args: ["--version"] }, timeoutMs: 10000 }, 0);
  const source = engine.discovery.evidence.document(project, "json",
    JSON.stringify({ payload: { nested: [REF_SHAPED_DATA] } }), "application/json", 0);
  const r0 = engine.refinement.begin(project, "R0");
  engine.refinement.finishResearch(project, "R0", reference(r0), 0); engine.refinement.sealLayer(project, 1, 0);
  const draft = engine.refinement.begin(project, "R1"), question = store.get<any>(draft.value.questions[0]!)!;
  const observation = engine.discovery.evidence.observe(project, reference(source), { kind: "json-pointer", pointer: "/payload" });
  workingContext(store, project, draft.id, question.id, { observations: [observation] }, 100000,
    { purpose: "reader" });
  const archive = store.list<any>("research-context")
    .find(row => row.value.draft.id === draft.id && row.value.question.id === question.id)!;
  const page = readPilotContext(store, draft, reference(archive), "/body/observations/0", 100000);
  const retained = retainPilotRead(store, project, question.id,
    { action: "read_context", record: reference(archive), pointer: "/body/observations/0" }, page);
  const retainedSites = referenceSites(retained.kind, retained.value);
  assert.equal(retainedSites.some(site => site.ref.id === REF_SHAPED_DATA.id), false);
  assert.ok(retainedSites.some(site => site.field === "observation.record" && site.ref.id === archive.id));
  const pilot = configureReaderPilot(store, engine.environments, project, { experimental: true, active: true, stopAfter: "L2",
    reader: { actor: "reader", model: "fixture", effort: "high", speed: "inherited", command }, agentCommand: command,
    maxRequestChars: 100000, maxReadChars: 60000, maxReplyChars: 10000, maxCalls: 10, maxReportedTokens: 100000 }, 0);
  const result = await synthesisSession(store, draft, question, environment, pilotEnvironment(environment.value, pilot.value), pilot,
    { ...pilotContext(store, draft, question), workingSelections: [{ kind: "context", value: observation }] }, "Pause fixture");
  assert.equal((result as any).action, "pause");
  const sessions = store.list<any>("synthesis-session"), saved = sessions.find(row => row.value.basis?.materials?.length)!;
  assert.ok(saved, "The lawful producer saved its material basis");
  const sites = referenceSites(saved.kind, saved.value);
  assert.equal(sites.some(site => site.ref.id === REF_SHAPED_DATA.id), false);
  assert.ok(sites.some(site => site.field === "basis.materials[0].value.source" && site.ref.id === source.id));
  assert.ok(sites.some(site => site.field === "binding.draft" && site.ref.id === draft.id));
  assert.deepEqual(checkStoreIntegrity(store).findings, []);
  const reopened = new Store(database);
  try { assert.deepEqual(checkStoreIntegrity(reopened).findings, []); } finally { reopened.close(); }
});

test("om-fsck: a database the engine wrote has no findings; the manual check saves its result", t => {
  const f = fixture(t);
  const report = checkStoreIntegrity(f.store);
  assert.deepEqual(report.findings, []);
  assert.deepEqual([report.revisions, report.events, report.references, report.lastSequence], [3, 3, 1, 3]);
  assert.equal(integrityGate(f.store, PROJECT), null);
  const saved = runIntegrityCheck(f.store, { project: PROJECT });
  assert.ok(saved.ok);
  assert.equal(saved.value.id, integrityId(PROJECT));
  assert.deepEqual(saved.value.value.findings, []);
});

test("om-fsck finds each change of another connection at its address", t => {
  const f = fixture(t);
  // A body changed in place without its sha256.
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);
  assert.deepEqual(found(f.store), [`revision_corrupt:${f.a.id}@1`]);
  // The same body rewritten with its sha256: the row agrees with itself, b still names the old hash.
  f.foreign("UPDATE revisions SET sha256=? WHERE entity_id=? AND revision=1", digest(canonical({ text: "forged" })), f.a.id);
  assert.deepEqual(found(f.store), [`reference_forged:${f.b.id}@1`]);
  // A revision gone: the line has a hole and b names a revision the store does not hold.
  f.foreign("DELETE FROM revisions WHERE entity_id=? AND revision=1", f.a.id);
  const gone = found(f.store);
  assert.ok(gone.includes(`revision_gap:${f.a.id}@2`), gone.join());
  assert.ok(gone.includes(`reference_missing:${f.b.id}@1`), gone.join());
});

test("om-fsck owns a forged consumer intent history: the trusted read stays one row", t => {
  // G5a (№6218): the saved intent is a commit — a substituted byte in its
  // history is the whole-check's finding, never a re-proving walk on read.
  const f = fixture(t);
  const ref = (id: string, revision = 1) => ({ id, revision, hash: digest(`${id}:${revision}`) });
  const owner = ref("research-run:r"), draft = ref("discovery-draft:d"), question = ref("question:q");
  const value = { contract: "research-consumer-intent/v1", projectId: PROJECT, kind: "analyst", key: "k",
    rootKey: "k", generation: 0, previous: null, owner, draft, question,
    role: { actor: "a", model: "m", effort: "e", command: { executable: "x", args: [] } },
    dispatch: { projectId: PROJECT }, profile: null,
    cursor: { run: owner.id, turn: 1, context: {}, prompt: "p" },
    basis: [], guards: uniqueTransactionGuards([owner, draft, question]),
    state: "prepared", call: null, request: null, archive: null, outputs: null, refusal: null };
  const id = researchConsumerIntentId(PROJECT, "analyst", "k", 0);
  f.store.writeMany([{ id, kind: "research-consumer-intent", expected: 0, value }]);
  const [head] = f.store.writeMany([{ id, kind: "research-consumer-intent", expected: 1,
    value: { ...value, state: "running", call: ref("model-call:c"), request: ref("request-manifest:c"),
      archive: ref("archive:c") } }]);
  assert.deepEqual(readResearchConsumerIntent(f.store, reference(head!)).value, head!.value);
  // Raw SQL rewrites an earlier revision leaving its sha256 stale: the intact
  // head reads as before — the check alone owns history damage.
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ ...value, key: "forged" }), id);
  assert.deepEqual(readResearchConsumerIntent(f.store, reference(head!)).value, head!.value,
    "the committed row is trusted — the read does not re-walk its revisions");
  assert.ok(found(f.store).includes(`revision_corrupt:${id}@1`), found(f.store).join());
  // A self-consistent rewrite of the head moves its sha256, so the exact ref
  // captured before stops matching — the cheap identity check, still one read.
  const forgedHead = { ...(head!.value as Record<string, any>),
    cursor: { ...(head!.value as Record<string, any>).cursor, note: "forged" } };
  f.foreign("UPDATE revisions SET body=?, sha256=? WHERE entity_id=? AND revision=2",
    canonical(forgedHead), digest(canonical(forgedHead)), id);
  assert.throws(() => readResearchConsumerIntent(f.store, reference(head!)),
    { code: "research_consumer_intent_invalid" });
  assert.deepEqual(readResearchConsumerIntent(f.store, reference(f.store.get(id)!)).value, forgedHead,
    "the new exact ref trusts the self-consistent row — a consistent rewrite is outside the read's threat model");
});

test("om-fsck finds an event gone and a head moved back", t => {
  const f = fixture(t);
  f.foreign("DELETE FROM events WHERE entity_id=? AND revision=1", f.b.id);
  assert.deepEqual(found(f.store), [`event_missing:${f.b.id}@1`]);
  const g = fixture(t);
  g.foreign("UPDATE heads SET revision=1 WHERE entity_id=?", g.a.id);
  assert.equal(g.store.get(g.a.id)!.revision, 1, "The raw change does move what a read sees");
  assert.deepEqual(found(g.store), [`head_invalid:${g.a.id}@1`]);
});

test("om-fsck runs by itself at om-start and om-continue: damage stops the pass with its addresses, a repaired database starts", async t => {
  const f = fixture(t);
  const original = f.store.get(f.a.id, 1)!;
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical({ text: "forged" }), f.a.id);
  // Reads are trusted: nothing on the way of a read notices the damage — the check at the start does.
  assert.deepEqual(f.store.get(f.a.id, 1)!.value, { text: "forged" });
  refusedAs(await startPass(f.store, { project: PROJECT }), "store_damaged", `revision_corrupt ${f.a.id}@1`);
  refusedAs(await continuePass(f.store, { project: PROJECT }), "store_damaged", `revision_corrupt ${f.a.id}@1`);
  const gate = integrityGate(f.store, PROJECT)!;
  assert.equal(gate.ok, false);
  assert.equal(gate.refusal.route, "owner");
  const saved = f.store.get<IntegrityRecord>(integrityId(PROJECT))!;
  assert.deepEqual(saved.value.findings.map(finding => finding.code), ["revision_corrupt"]);
  // The check repairs nothing; the owner does (here: the original body back), and the next start passes the check.
  f.foreign("UPDATE revisions SET body=? WHERE entity_id=? AND revision=1", canonical(original.value), f.a.id);
  assert.equal(integrityGate(f.store, PROJECT), null);
  const started = await startPass(f.store, { project: PROJECT });
  assert.notEqual(started.ok ? "started" : started.refusal.code, "store_damaged");
});

test("om-fsck reads one committed snapshot: a lawful write of another connection between its reads is no damage (№3674 п.1)", t => {
  const f = fixture(t);
  const prepare = DatabaseSync.prototype.prepare;
  let injected = false;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    if (!injected && sql.startsWith("SELECT entity_id, revision FROM heads")) {
      injected = true;
      const other = new Store(f.path);
      try { other.writeMany([{ id: "note:garden:concurrent", kind: "note", expected: 0, value: { text: "written meanwhile" } },
        { id: f.a.id, kind: "note", expected: 2, value: { text: "third" } }]); } finally { other.close(); }
    }
    return prepare.call(this, sql);
  } as typeof DatabaseSync.prototype.prepare;
  let report;
  try { report = checkStoreIntegrity(f.store); } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.ok(injected, "The other connection wrote between the reads of the check");
  assert.deepEqual(report.findings, []);
  assert.deepEqual([report.revisions, report.lastSequence], [3, 3], "The check saw the snapshot it began with");
  const after = checkStoreIntegrity(f.store);
  assert.deepEqual([after.findings, after.revisions], [[], 5], "The next check sees the write whole");
  assert.equal(integrityGate(f.store, PROJECT), null);
});

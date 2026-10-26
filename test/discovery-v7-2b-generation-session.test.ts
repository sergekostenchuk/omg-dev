import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "../src/errors.js";
import { canonical, hashJson } from "../src/canonical.js";
import { reference, type Ref } from "../src/pipeline/contracts.js";
import type { Selector } from "../src/evidence/evidence.js";
import { Store, type Revision } from "../src/storage/store.js";
import { readEnvironmentAt, type Environment, type RoleBinding } from "../src/runtime/environment.js";
import { Discovery, type DiscoveryDraft, type Question } from "../src/discovery/discovery.js";
import { createPartialV7Draft, V7_FRAME_INTERPRETATIONS_CONTRACT,
  V7_FRAME_INTERPRETATIONS_KIND } from "../src/discovery/v7-contracts.js";
import { projectFrameInterpretations } from "../src/discovery/frame-interpretations.js";
import type { FrameSubjectRequest } from "../src/discovery/frame-interpretation-subject.js";
import { prepareFrameInterpretationEnvelope,
  type FrameEnvelopeInput } from "../src/discovery/frame-interpretation-packing.js";
import { readArchiveBody } from "../src/discovery/request-parts.js";
import { prepareFrameInterpretationSession, readFrameInterpretationSession,
  FRAME_INTERPRETATION_SESSION_CONTRACT, FRAME_INTERPRETATION_SESSION_KIND,
  type FrameInterpretationSession } from "../src/discovery/interpretation-session.js";
import { referenceSites } from "../src/storage/reference-sites.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { discoveryFixture, questionOf, validFrame,
  type DiscoveryFixture } from "./discovery-v7-fixture.js";

// DR2b 2b-GENERATION-SESSION (codex-omg №15271): the persisted prepared
// generation session over an accepted PACK envelope — deterministic identity,
// atomic expected:0 creation, repeat/race semantics, the exact reader that
// re-binds every saved ground. No paid call, result, choice or publication.

const TEXT_BRIEF = "XX Учёт материалов ведётся на центральном складе и списание идёт на каждом объекте. YY";
const RANGE = { kind: "text-range", start: 3, end: 62 } as const;

const state = (store: Store, wireFile: string) => ({
  heads: canonical(store.list()),
  revisions: canonical(store.list().map(row => [row.id, store.history(row.id)])),
  calls: canonical(store.list("model-call")),
  ledger: canonical(store.list("research-budget-ledger")),
  wire: existsSync(wireFile) ? readFileSync(wireFile, "utf8") : null,
});
function noWrite<T>(store: Store, wireFile: string, action: () => Promise<T>): Promise<T>;
function noWrite<T>(store: Store, wireFile: string, action: () => T): T;
function noWrite(store: Store, wireFile: string, action: () => unknown): unknown {
  const before = state(store, wireFile);
  const verify = () => assert.deepEqual(state(store, wireFile), before,
    "a read-only block changed the saved state");
  try {
    const result = action();
    if (result instanceof Promise) return result.finally(verify);
    verify();
    return result;
  } catch (error) {
    verify();
    throw error;
  }
}
const code = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`);
    return (error as EngineError).code;
  }
  return "no-error";
};
const field = (fn: () => unknown): string => {
  try { fn(); } catch (error) {
    return ((error as EngineError).details as { field?: string } | null)?.field ?? "?";
  }
  return "no-error";
};

interface Base {
  src: Revision<{ content: string }>;
  draft: Revision<DiscoveryDraft>;
  briefQ: Revision<Question>;
  planQ: Revision<Question>;
  frameQ: Revision<Question>;
  frameRef: Ref;
  mandate: { source: Ref; selector: Selector };
}

function base(f: DiscoveryFixture, project: string, sourceKey = "brief-src"): Base {
  const selector: Selector = { ...RANGE };
  const src = f.discovery.evidence.document(project, sourceKey, TEXT_BRIEF, "text/plain", 0);
  const draft = createPartialV7Draft(f.discovery, project, "concept", [reference(src)]);
  const briefQ = questionOf(f.store, draft, "brief");
  f.engine.discovery.fact(briefQ.id, briefQ.revision, reference(src), selector);
  const objective = questionOf(f.store, draft, "objective");
  f.engine.discovery.decision(objective.id, f.store.get<Question>(objective.id)!.revision,
    "owner", `Deliver ${project} outcome`);
  const frameQ = questionOf(f.store, draft, "frame");
  answerDiscoveryFixture(f.engine, project, f.store.get<DiscoveryDraft>(draft.id)!,
    f.store.get<Question>(frameQ.id)!, validFrame(), src);
  const planQ = questionOf(f.store, draft, "plan");
  const frameRef = f.store.get<Question>(frameQ.id)!.value.answer!;
  return { src, draft, briefQ, planQ, frameQ, frameRef, mandate: { source: reference(src), selector } };
}

const requestOf = (project: string, b: Base, previousSet?: Ref | null): FrameSubjectRequest =>
  ({ project, frame: b.frameRef, mandate: b.mandate as FrameSubjectRequest["mandate"],
    ...(previousSet !== undefined ? { previousSet } : {}) });

const IMPLEMENTER: RoleBinding = { actor: "impl-actor", model: "managed-model",
  effort: "high", command: { executable: "managed-runner", args: ["run"] } };
const REVIEWER: RoleBinding = { actor: "rev-actor", model: "managed-model",
  effort: "medium", command: { executable: "managed-runner", args: ["check"] } };
const environmentValue = (project: string, root: string): Environment => ({
  projectId: project, workspace: root, implementer: structuredClone(IMPLEMENTER),
  reviewer: structuredClone(REVIEWER), fullCheck: { executable: "managed-check", args: [] },
  timeoutMs: 60000 });
/** A real saved environment record — the only way a session environment can exist. */
const saveEnvironment = (f: DiscoveryFixture, project: string): Revision<Environment> =>
  f.store.writeMany<Environment>([{ id: `environment:${project}`, kind: "environment",
    expected: 0, value: environmentValue(project, f.root) }])[0]!;

const envelopeInput = (project: string, root: string): FrameEnvelopeInput => ({
  prompt: "Build the interpretations set for this frame.",
  packetChars: 150000, limitChars: 200000, role: structuredClone(IMPLEMENTER),
  environment: environmentValue(project, root) });

function writeStructuralSet(store: Store, value: Record<string, unknown>): Ref {
  const projected = projectFrameInterpretations(value);
  const row = store.write({ id: projected.id, kind: V7_FRAME_INTERPRETATIONS_KIND,
    expected: 0, value: projected.value });
  return reference(row);
}
const plainSet = (project: string, brief: { source: Ref; selector: unknown }, frame: Ref,
  previousSet: Ref | null = null): Record<string, unknown> => ({
  contract: V7_FRAME_INTERPRETATIONS_CONTRACT, projectId: project,
  brief: { source: { ...brief.source }, selector: structuredClone(brief.selector) },
  frame, previousSet, outcome: "no_divergence",
  reason: "One warehouse reading, no divergence", interpretations: [] });

const sessions = (store: Store) => store.list().filter(row => row.kind === FRAME_INTERPRETATION_SESSION_KIND);

test("2b-SES a saved envelope becomes one prepared session: deterministic identity, exact bindings, atomic create, isolated return", (t) => {
  const f = discoveryFixture(t, "omg-2bs-main-"), project = "garden";
  const wireFile = join(f.root, "wire.ndjson");
  const envRow = saveEnvironment(f, project);
  const first = base(f, project, "brief-src");
  const prev = writeStructuralSet(f.store, plainSet(project, first.mandate, first.frameRef));
  const b = base(f, project, "brief-src-2");
  const req = requestOf(project, b, prev);
  const input = envelopeInput(project, f.root);
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  const before = state(f.store, wireFile);
  const session = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
  // The only new record is the session itself — no call, ledger, wire or choice.
  const after = state(f.store, wireFile);
  assert.equal(after.calls, "[]"); assert.equal(after.ledger, "[]"); assert.equal(after.wire, null);
  const newIds = (JSON.parse(after.heads) as { id: string; kind: string }[])
    .filter(row => !(JSON.parse(before.heads) as { id: string }[]).some(o => o.id === row.id));
  assert.deepEqual(newIds.map(row => row.kind), [FRAME_INTERPRETATION_SESSION_KIND],
    "the prepared session is the single new record");
  assert.equal(session.kind, FRAME_INTERPRETATION_SESSION_KIND);
  assert.equal(session.revision, 1);
  assert.equal(session.value.contract, FRAME_INTERPRETATION_SESSION_CONTRACT);
  assert.equal(session.id, `frame-interpretation-session:${project}:${hashJson(session.value)}`,
    "the deterministic identity derives from the whole bound value");
  // Bound grounds are the proven request and envelope — never today's heads.
  assert.equal(canonical(session.value.request), canonical(env.request));
  assert.equal(canonical(session.value.envelope), canonical(env));
  assert.equal(canonical(session.value.brief), canonical(env.request.brief));
  assert.equal(canonical(session.value.frame), canonical(env.request.frame));
  assert.equal(canonical(session.value.previousSet), canonical(prev));
  assert.equal(canonical(session.value.archive), canonical(env.archive));
  assert.equal(canonical(session.value.environment), canonical(reference(envRow)));
  assert.equal(canonical(session.value.role), canonical(input.role));
  assert.equal(session.value.state, "prepared");
  assert.deepEqual(session.value.cursor, { offset: 0 });
  assert.equal(session.value.result, null);
  // The declared structural sites name exactly the bound exact references.
  const sites = referenceSites(session.kind, session.value);
  const paths = sites.map(site => site.field).sort();
  assert.deepEqual(paths, ["archive", "brief.source", "environment", "frame", "previousSet"],
    "the session declares every bound exact reference and nothing else");
  for (const site of sites) {
    const target = f.store.get(site.ref.id, site.ref.revision);
    assert.ok(target && target.hash === site.ref.hash, `site ${site.field} resolves to saved bytes`);
  }
  // The returned object is isolated from the saved bytes.
  (session.value as any).result = { fake: true };
  assert.equal((f.store.get<FrameInterpretationSession>(session.id)!.value).result, null,
    "mutating the return never reaches the record");
  // A repeat is a read: the same exact session, zero writes.
  noWrite(f.store, wireFile, () => {
    const again = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
    assert.equal(again.id, session.id);
    assert.equal(canonical(again.value), canonical(f.store.get(session.id)!.value));
    assert.equal(sessions(f.store).length, 1, "the repeat wrote no second session");
  });
  // The exact reader re-binds every ground; a cold Store returns the same.
  noWrite(f.store, wireFile, () => {
    const read = readFrameInterpretationSession(f.store, project, reference(session));
    assert.equal(canonical(read.value), canonical(f.store.get(session.id)!.value));
  });
  const cold = f.open();
  noWrite(cold, wireFile, () => {
    const read = readFrameInterpretationSession(cold, project, reference(session));
    assert.equal(canonical(read.value.request), canonical(env.request));
  });
});

test("2b-SES an addressed saved envelope binds the same way and its archive resolves through the session", (t) => {
  const f = discoveryFixture(t, "omg-2bs-addr-"), project = "attic";
  const wireFile = join(f.root, "wire.ndjson");
  saveEnvironment(f, project);
  const b = base(f, project);
  const req = requestOf(project, b);
  const input: FrameEnvelopeInput = { prompt: "Build the interpretations set.",
    packetChars: 6000, limitChars: 20000, role: structuredClone(IMPLEMENTER),
    environment: environmentValue(project, f.root) };
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  assert.ok((env.packet.working.materialAddresses as unknown[] | undefined)?.length,
    "the oversized request is address-delivered");
  const session = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
  // The session's bound archive restores every request byte on a cold Store.
  const cold = f.open();
  const row = cold.get(session.value.archive.id, session.value.archive.revision)!;
  assert.equal(canonical(readArchiveBody(cold, row).body['frameRequest']), canonical(env.request));
  const read = readFrameInterpretationSession(cold, project, reference(session));
  assert.equal(canonical(read.value.envelope.packet), canonical(env.packet));
  assert.equal(state(cold, wireFile).wire, null);
});

test("2b-SES a session is never created for a missing archive: the real-database snapshot refuses read-only", async (t) => {
  const f = discoveryFixture(t, "omg-2bs-snap-"), project = "freezer";
  const wireFile = join(f.root, "wire.ndjson");
  saveEnvironment(f, project);
  const b = base(f, project);
  const req = requestOf(project, b);
  const input = envelopeInput(project, f.root);
  const snap = await f.store.snapshot(join(f.root, "snapshots"));
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  const cold = new Store(snap.path);
  t.after(() => cold.close());
  noWrite(cold, wireFile, () => {
    assert.deepEqual([code(() => prepareFrameInterpretationSession(cold, req, input, structuredClone(env))),
      field(() => prepareFrameInterpretationSession(cold, req, input, structuredClone(env)))],
      ["frame_pack_mismatch", "archive"]);
    assert.equal(cold.get(env.archive.id, env.archive.revision), null,
      "the missing archive is never rebuilt by session preparation");
    assert.equal(sessions(cold).length, 0);
  });
});

test("2b-SES late heads of frame, brief, Source and environment leave the exact session and reader untouched", (t) => {
  const f = discoveryFixture(t, "omg-2bs-heads-"), project = "attic2";
  const wireFile = join(f.root, "wire.ndjson");
  const envRow = saveEnvironment(f, project);
  const b = base(f, project);
  const req = requestOf(project, b);
  const input = envelopeInput(project, f.root);
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  const session = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
  // Move every head the session could be accused of following — including a
  // second environment revision; the bound Ref stays on the proven revision.
  f.discovery.reopen(b.frameQ.id, f.store.get<Question>(b.frameQ.id)!.revision);
  f.discovery.reopen(b.briefQ.id, f.store.get<Question>(b.briefQ.id)!.revision);
  const moving = f.open();
  const movingDiscovery = new Discovery(moving);
  movingDiscovery.evidence.document(project, "brief-src", "Поздняя редакция", "text/plain",
    moving.get<{ content: string }>(b.src.id)!.revision);
  const laterEnvironment = f.store.writeMany<Environment>([{
    id: `environment:${project}`, kind: "environment", expected: envRow.revision,
    value: { ...environmentValue(project, f.root), timeoutMs: 90000 } }])[0]!;
  assert.equal(laterEnvironment.revision, envRow.revision + 1, "the environment head moved");
  const later = f.store.get<Question>(b.frameQ.id)!;
  assert.ok(later.revision > b.frameQ.revision, "the frame question head moved");
  noWrite(f.store, wireFile, () => {
    const read = readFrameInterpretationSession(f.store, project, reference(session));
    assert.equal(canonical(read.value), canonical(session.value),
      "the exact session survives every moved head");
    assert.equal(read.value.environment.revision, envRow.revision,
      "the bound environment stays on the proven revision");
    // A repeat under the moved heads is still the same read — no new record.
    const again = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
    assert.equal(again.id, session.id);
    assert.equal(sessions(f.store).length, 1);
    // The proven environment revision still resolves by Ref and bytes.
    assert.equal(readEnvironmentAt(f.store, project, read.value.environment).value.timeoutMs, 60000);
  });
});

test("2b-SES a second Store racing the create lands between the absent read and expected:0 — the first prepare returns the lawful winner", (t) => {
  const f = discoveryFixture(t, "omg-2bs-race-"), project = "vault";
  const wireFile = join(f.root, "wire.ndjson");
  saveEnvironment(f, project);
  const b = base(f, project);
  const req = requestOf(project, b);
  const input = envelopeInput(project, f.root);
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  const first = f.store, second = f.open();
  const before = state(first, wireFile);
  // Inside the first prepare's own writeMany — after its absent head read and
  // before its expected:0 insert commits — the second Store lawfully prepares
  // the same session and wins the create.
  let winner: Revision<FrameInterpretationSession> | null = null;
  const original = first.writeMany.bind(first);
  (first as any).writeMany = (writes: Parameters<Store["writeMany"]>[0],
    guards?: Parameters<Store["writeMany"]>[1]) => {
    if (!winner)
      winner = prepareFrameInterpretationSession(second, req, input, structuredClone(env));
    return original(writes, guards);
  };
  let raced: Revision<FrameInterpretationSession>;
  try { raced = prepareFrameInterpretationSession(first, req, input, structuredClone(env)); }
  finally { delete (first as any).writeMany; } // no own method is left on the Store
  const won = winner as Revision<FrameInterpretationSession> | null;
  assert.ok(won, "the second store created the session inside the window");
  assert.equal(raced.id, won.id, "the first prepare returns the exact winner ref");
  assert.equal(canonical(raced.value), canonical(won.value));
  assert.equal(sessions(first).length, 1, "the race wrote no duplicate session");
  const session = f.store.get<FrameInterpretationSession>(raced.id, raced.revision)!;
  // The write touched exactly the one session row — nothing else moved.
  const after = state(first, wireFile);
  assert.equal(after.calls, "[]"); assert.equal(after.ledger, "[]"); assert.equal(after.wire, null);
  const newIds = (JSON.parse(after.heads) as { id: string; kind: string }[])
    .filter(row => !(JSON.parse(before.heads) as { id: string }[]).some(o => o.id === row.id));
  assert.deepEqual(newIds.map(row => row.kind), [FRAME_INTERPRETATION_SESSION_KIND]);
  // Forged or missing refs refuse at their exact reader doors.
  noWrite(f.store, wireFile, () => {
    assert.equal(code(() => readFrameInterpretationSession(f.store, project,
      { id: `frame-interpretation-session:${project}:${"0".repeat(64)}`, revision: 1, hash: "0".repeat(64) })),
      "frame_session_missing");
    assert.equal(code(() => readFrameInterpretationSession(f.store, project,
      { id: session.id, revision: 2, hash: session.hash })), "frame_session_missing");
    assert.equal(code(() => readFrameInterpretationSession(f.store, project,
      { id: session.id, revision: 1, hash: "1".repeat(64) })), "frame_session_mismatch");
  });
  // A fully consistent session of the same project under a wrong address —
  // every byte lawful — refuses at the derived-id door alone; this probe
  // stands or falls with that comparison, not another inconsistency.
  const wrongId = `frame-interpretation-session:${project}:wrong-address`;
  f.store.writeMany([{ id: wrongId, kind: FRAME_INTERPRETATION_SESSION_KIND,
    expected: 0, value: structuredClone(session.value) }]);
  noWrite(f.store, wireFile, () => {
    const row = f.store.get(wrongId)!;
    assert.deepEqual([code(() => readFrameInterpretationSession(f.store, project,
      { id: row.id, revision: row.revision, hash: row.hash })),
      field(() => readFrameInterpretationSession(f.store, project,
        { id: row.id, revision: row.revision, hash: row.hash }))],
      ["frame_session_mismatch", "record"]);
  });
});

test("2b-SES masquerading paid, selected, applied or foreign-purpose fields refuse at the closed form, and a rebound ground never yields a foreign session", (t) => {
  const f = discoveryFixture(t, "omg-2bs-form-"), project = "barn";
  const wireFile = join(f.root, "wire.ndjson");
  saveEnvironment(f, project);
  const b = base(f, project);
  const req = requestOf(project, b);
  const input = envelopeInput(project, f.root);
  const env = prepareFrameInterpretationEnvelope(f.store, req, input);
  const session = prepareFrameInterpretationSession(f.store, req, input, structuredClone(env));
  const ownId = (v: unknown) => `frame-interpretation-session:${project}:${hashJson(v)}`;
  // Forge the probe rows first — each is a real stored record; the reads below
  // stay inside the read-only window.
  const probes: { id: string; revision: number; hash: string; expected: [string, string] }[] = [];
  const forge = (name: string, mutate: (v: Record<string, any>) => void,
    expected: [string, string], ownAddress = false): void => {
    const bad = structuredClone(session.value) as Record<string, any>;
    mutate(bad);
    const id = ownAddress ? ownId(bad) : `frame-interpretation-session:${project}:probe-${name}`;
    const row = f.store.writeMany([{ id, kind: FRAME_INTERPRETATION_SESSION_KIND,
      expected: 0, value: bad }])[0]!;
    probes.push({ id: row.id, revision: row.revision, hash: row.hash, expected });
  };
  // Every paid/applied/selected/publication/purpose key is outside the form.
  for (const key of ["paid", "applied", "selected", "publication", "purpose"])
    forge(key, v => { v[key] = true; }, ["frame_session_invalid", `session.${key}`]);
  // Only the prepared state, the initial cursor and a null result exist.
  forge("result", v => { v.result = { chosen: "first" }; }, ["frame_session_invalid", "session.result"]);
  forge("state", v => { v.state = "completed"; }, ["frame_session_invalid", "session.state"]);
  forge("cursor", v => { v.cursor = { offset: 5 }; }, ["frame_session_invalid", "session.cursor"]);
  // A substituted request identity is the request decoder's own refusal.
  forge("request", v => { v.request.instruction = "Pick the winner"; },
    ["frame_request_invalid", "?"]);
  // A substituted archive binding reaches the session consistency door — the
  // forged value sits under its own derived id, so the content check fires.
  forge("archive", v => { v.archive = { id: `research-context:${"2".repeat(64)}`,
    revision: 1, hash: "2".repeat(64) }; }, ["frame_session_mismatch", "session.archive"], true);
  // A substituted environment binding reaches the saved-environment door:
  // revision 2 of the environment exists, so the Ref proves — but its bytes
  // are not the preparation's environment value.
  const laterEnv = f.store.writeMany<Environment>([{ id: `environment:${project}`,
    kind: "environment", expected: 1,
    value: { ...environmentValue(project, f.root), timeoutMs: 91000 } }])[0]!;
  forge("environment", v => { v.environment = reference(laterEnv); },
    ["frame_session_mismatch", "environment"], true);
  // A role that is no declared role of the saved environment — same model and
  // effort, so the wire bytes and capacity stay identical and the membership
  // door itself fires — for the reader on a record under its own derived id.
  const foreignRole: RoleBinding = { actor: "outside-actor", model: IMPLEMENTER.model,
    effort: IMPLEMENTER.effort, command: { executable: "outside-runner", args: ["run"] } };
  forge("role", v => { v.role = structuredClone(foreignRole);
    v.input.role = structuredClone(foreignRole); },
    ["frame_session_mismatch", "role"], true);
  noWrite(f.store, wireFile, () => {
    for (const { id, revision, hash, expected } of probes) {
      const ref = { id, revision, hash };
      const [actualCode, actualField] = [code(() => readFrameInterpretationSession(f.store, project, ref)),
        field(() => readFrameInterpretationSession(f.store, project, ref))];
      if (expected[1] === "?") assert.equal(actualCode, expected[0], `${id} refused with ${actualCode}`);
      else assert.deepEqual([actualCode, actualField], expected, `${id} refused at its own door`);
    }
  });
  // Substituted preparation parameters refuse before identity is trusted:
  // a different role rebuilds a different envelope — the input compare door.
  const roleSwap = { ...input, role: structuredClone(REVIEWER) };
  noWrite(f.store, wireFile, () => {
    // A different role rebuilds a different envelope — the capacity door
    // measures it before the field compare reaches the input field.
    assert.equal(code(() => prepareFrameInterpretationSession(f.store, req, roleSwap,
      structuredClone(env))), "research_capacity_invalid");
    // Same model and effort but a foreign actor and command: the rebuilt
    // envelope and capacity match byte for byte, so the prepare membership
    // door itself refuses — not an earlier capacity or input door.
    const foreignInput = { ...input, role: { actor: "outside-actor", model: IMPLEMENTER.model,
      effort: IMPLEMENTER.effort, command: { executable: "outside-runner", args: ["run"] } } };
    assert.deepEqual([code(() => prepareFrameInterpretationSession(f.store, req, foreignInput,
      structuredClone(env))),
      field(() => prepareFrameInterpretationSession(f.store, req, foreignInput, structuredClone(env)))],
      ["frame_session_mismatch", "role"]);
    // An environment of another project refuses at the envelope's own binding.
    const foreignProject = { ...input, environment: environmentValue("other-yard", f.root) };
    assert.equal(field(() => prepareFrameInterpretationSession(f.store, req, foreignProject,
      structuredClone(env))), "environment.projectId");
    // A same-project environment value that is no saved revision: the wire
    // input carries no workspace, so the envelope still verifies — and the
    // saved-environment door catches the substitution itself.
    const unsaved = { ...input, environment: environmentValue(project, "/private/var/elsewhere") };
    assert.deepEqual([code(() => prepareFrameInterpretationSession(f.store, req, unsaved,
      structuredClone(env))),
      field(() => prepareFrameInterpretationSession(f.store, req, unsaved, structuredClone(env)))],
      ["frame_session_missing", "environment"]);
  });
});

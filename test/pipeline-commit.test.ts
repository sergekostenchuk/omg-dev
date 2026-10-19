import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, storeBodyCache, storeReads, type Revision, type TransactionGuard } from "../src/storage/store.js";
import { Pipeline } from "../src/pipeline/pipeline.js";
import { EngineError } from "../src/errors.js";
import { digest } from "../src/canonical.js";
import { sourceIsCurrent, type Source } from "../src/evidence/evidence.js";
import { historicalRead, withHistoricalReads } from "../src/history/proofs.js";
import { STAGES, STAGE_CLOSURE_CONTRACT, reference,
  type Stage, type StageArtifact, type StageClosure, type StageExternalCheck, type ExternalCheckHandler, type ExternalCheckHandlers,
  type StageProjection, type StageValidator, type StageValidators, type Finding, type Ref } from "../src/pipeline/contracts.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof EngineError && error.code === expected;
type StageRevision = Revision<StageArtifact>;

interface Fixture {
  root: string; store: Store; file: string; source: Ref;
  calls: Map<Stage, number>;
  /** Builds validators: every stage re-checks its declared sources inside its own gate (so the full path
   * finds the same staleness the closure check would), returns `extraGuards`/`extraAdmission` and, for
   * stages `declareStage` allows, issues the explicit stage-closure/v1 declaration — an empty external
   * list IS a declaration, a missing `closure` field is not. */
  pipeline(options?: { external?: Partial<Record<Stage, StageExternalCheck[]>>;
    declareStage?: (stage: Stage) => boolean;
    extraGuards?: Partial<Record<Stage, Ref[]>>;
    extraAdmission?: Partial<Record<Stage, TransactionGuard[]>>;
    handlers?: ExternalCheckHandlers }): Pipeline;
}

function fixture(t: test.TestContext): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omg-commit-")));
  const store = new Store(join(root, "state.sqlite"));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, "basis.txt");
  writeFileSync(file, "basis-v1");
  const record = store.write<Source>({ id: "source:garden:basis", kind: "source", expected: 0,
    value: { projectId: "garden", origin: { kind: "file", location: file },
      content: "basis-v1", mediaType: "text/plain", sha256: digest("basis-v1") } });
  const source = reference(record);
  const calls = new Map<Stage, number>(STAGES.map(stage => [stage, 0]));
  const pipeline: Fixture['pipeline'] = (options = {}) => {
    const validators = Object.fromEntries(STAGES.map(stage => [stage, (() => {
      calls.set(stage, calls.get(stage)! + 1);
      const external = options.external?.[stage] ?? [{ kind: "source" as const, ref: source }];
      const findings: Finding[] = [];
      for (const check of external) {
        if (check.kind === "source") {
          const found = store.get<Source>(check.ref.id, check.ref.revision);
          if (!found || found.kind !== "source" || !sourceIsCurrent(found.value))
            findings.push({ code: "external_source_changed", target: check.ref.id, message: "The declared external source changed" });
        }
      }
      const declared = options.declareStage ? options.declareStage(stage) : true;
      return { findings, guards: [...(options.extraGuards?.[stage] ?? [])],
        admissionGuards: [...(options.extraAdmission?.[stage] ?? [])],
        ...(declared ? { closure: { contract: STAGE_CLOSURE_CONTRACT, external } } : {}) };
    }) as StageValidator])) as StageValidators;
    return new Pipeline(store, validators, options.handlers);
  };
  return { root, store, file, source, calls, pipeline };
}

const acceptAll = (pipeline: Pipeline, project: string, stages: readonly Stage[] = STAGES): StageRevision[] => {
  const accepted: StageRevision[] = [];
  for (const stage of stages) {
    const draft = pipeline.draft(project, stage, { title: `${project}-${stage}` }, 0);
    accepted.push(pipeline.accept(project, stage, draft.revision));
  }
  return accepted;
};
const reads = (action: () => void): number => { const before = storeReads(); action(); return storeReads() - before; };
const closureOf = (artifact: StageRevision): StageClosure => {
  const closure = artifact.value.closure;
  assert.ok(closure && typeof closure === "object");
  return closure;
};

test("an accepted stage carries its stage-closure/v1 commit — proofs, admission with absent, inherited checks, write guards — and a closed read runs no validator", t => {
  const f = fixture(t);
  const ghost: TransactionGuard = { id: "ghost:garden", absent: true };
  const evidence = reference(f.store.write({ id: "evidence:garden", kind: "evidence", expected: 0, value: {} }));
  const graphHead = reference(f.store.write({ id: "graph:garden", kind: "graph", expected: 0, value: {} }));
  const pipeline = f.pipeline({ extraGuards: { discovery: [evidence] }, extraAdmission: { discovery: [ghost] } });
  const draft = pipeline.draft("garden", "discovery", { title: "Garden" }, 0);
  const accepted = pipeline.accept("garden", "discovery", draft.revision, [graphHead]);
  const closure = closureOf(accepted);
  assert.equal(closure.contract, STAGE_CLOSURE_CONTRACT);
  assert.deepEqual(closure.proofs, accepted.value.proofs);
  assert.ok(accepted.value.proofs.some(ref => ref.id === evidence.id));
  assert.ok(closure.admission.some(guard => 'absent' in guard && guard.id === ghost.id));
  assert.deepEqual(closure.external, [{ kind: "source", ref: f.source }]);
  assert.deepEqual(closure.inherited, []);
  // The acceptance write's own guards — the old stage revision and the graph head — are the commit's audit, not proofs.
  assert.ok(closure.writeGuards.some(guard => 'revision' in guard && guard.id === graphHead.id));
  assert.ok(closure.writeGuards.some(guard => 'revision' in guard && guard.id === draft.id && guard.revision === draft.revision));
  assert.ok(!accepted.value.proofs.some(ref => ref.id === graphHead.id));
  // The second acceptance entry writes the same contract, and records the predecessor's checks as inherited.
  const prepared = pipeline.prepareAccepted("garden", "concept", { title: "Concept" }, 0);
  const concept = f.store.writeMany<StageArtifact>([prepared.write], prepared.guards)[0]!;
  const conceptClosure = closureOf(concept);
  assert.equal(conceptClosure.contract, STAGE_CLOSURE_CONTRACT);
  assert.deepEqual(conceptClosure.inherited, [{ kind: "source", ref: f.source }], "the predecessor's checks are inherited");
  assert.deepEqual(conceptClosure.external, [{ kind: "source", ref: f.source }]);
  // A closed read: one artifact body, one heads snapshot, one source body — the stage validator never runs.
  f.calls.set("discovery", 0);
  const parsed = storeBodyCache().parses;
  const used = reads(() => {
    const projection = pipeline.inspect("garden", "discovery");
    assert.equal(projection.state, "accepted");
    assert.deepEqual(projection.findings, []);
    assert.deepEqual(projection.artifact, accepted);
    assert.ok(projection.guards.some(ref => ref.id === evidence.id));
    assert.ok(projection.admissionGuards?.some(guard => 'absent' in guard && guard.id === ghost.id));
  });
  assert.equal(used, 3, "artifact body + one headsMatch + one source body — never the validator's walk");
  assert.equal(storeBodyCache().parses - parsed, 2,
    "the artifact and the source bodies are parsed — never a proof's body");
  assert.equal(f.calls.get("discovery"), 0, "the stage validator did not run");
  f.calls.set("concept", 0);
  const conceptUsed = reads(() => assert.equal(pipeline.inspect("garden", "concept").state, "accepted"));
  assert.equal(conceptUsed, 3, "the inherited and the own check on one source run once per read");
  assert.equal(f.calls.get("concept"), 0);
});

test("a closed read answers saved-guard breaches itself and falls back to the full path on external misses", t => {
  const f = fixture(t);
  const ghost: TransactionGuard = { id: "ghost:garden", absent: true };
  const evidence = reference(f.store.write({ id: "evidence:garden", kind: "evidence", expected: 0, value: {} }));
  const pipeline = f.pipeline({ extraGuards: { discovery: [evidence] }, extraAdmission: { discovery: [ghost] } });
  const discovery = acceptAll(pipeline, "garden", ["discovery"])[0]!;
  // A committed proof moved: the saved proofs are the acceptance condition itself — the closure names
  // the same proof_stale code the old inspection names, before the validator is ever reached.
  f.store.write({ id: evidence.id, kind: "evidence", expected: evidence.revision, value: { moved: true } });
  f.calls.set("discovery", 0);
  const stale = pipeline.inspect("garden", "discovery");
  assert.equal(stale.state, "stale");
  assert.equal(f.calls.get("discovery"), 0, "proof_stale is found in the same place the old path found it");
  assert.ok(stale.findings.some(finding => finding.code === "proof_stale"));
  assert.deepEqual(discovery.value.status, "accepted", "history was not rewritten");
  // An absent admission guard became present: the saved admission is the acceptance condition itself,
  // so the recorded closure names input_stale without ever asking the validator for a fresh one (№6232).
  const f2 = fixture(t);
  const ghost2: TransactionGuard = { id: "ghost:garden", absent: true };
  const pipeline2 = f2.pipeline({ extraAdmission: { discovery: [ghost2] } });
  acceptAll(pipeline2, "garden", ["discovery"]);
  f2.store.write({ id: "ghost:garden", kind: "revocation", expected: 0, value: {} });
  f2.calls.set("discovery", 0);
  const stale2 = pipeline2.inspect("garden", "discovery");
  assert.equal(stale2.state, "stale");
  assert.equal(f2.calls.get("discovery"), 0, "the recorded closure answers its own breach");
  assert.ok(stale2.findings.some(finding => finding.code === "input_stale" && finding.target === "ghost:garden"));
  // The declared external file changed: the check fails, the validator's own code answers.
  const f3 = fixture(t);
  const pipeline3 = f3.pipeline();
  acceptAll(pipeline3, "garden", ["discovery", "concept"]);
  writeFileSync(f3.file, "basis-v2");
  f3.calls.set("discovery", 0); f3.calls.set("concept", 0);
  const own = pipeline3.inspect("garden", "discovery");
  assert.equal(own.state, "stale"); assert.equal(f3.calls.get("discovery"), 1);
  assert.ok(own.findings.some(finding => finding.code === "external_source_changed"));
  // The predecessor's external change is found by a single closed read of the later stage (№6174 п.2):
  // the inherited check misses, and the full path answers input_stale exactly where it always did —
  // the predecessor's stale projection, before any validator of this stage runs.
  const later = pipeline3.inspect("garden", "concept");
  assert.equal(later.state, "stale");
  assert.ok(later.findings.some(finding => finding.code === "input_stale"));
  assert.equal(f3.calls.get("concept"), 0);
  assert.equal(f3.calls.get("discovery"), 2, "the fallback re-inspected the predecessor once");
  // A declared kind with no registered executor is never a silent pass: the full path answers (№6201 п.1).
  const f4 = fixture(t);
  const pipeline4 = f4.pipeline({ external: { discovery: [{ kind: "repository", basis: f4.source }] } });
  acceptAll(pipeline4, "garden", ["discovery"]);
  f4.calls.set("discovery", 0);
  assert.equal(pipeline4.inspect("garden", "discovery").state, "accepted");
  assert.equal(f4.calls.get("discovery"), 1, "no executor → the full path answers");
  // The executor the caller registers for that kind replaces the gap — the closed read uses it (№6210).
  const f5 = fixture(t);
  const repositoryCheck: ExternalCheckHandler<"repository"> = () => null;
  const validators5 = Object.fromEntries(STAGES.map(stage => [stage, (() => {
    f5.calls.set(stage, f5.calls.get(stage)! + 1);
    return { findings: [], guards: [],
      closure: { contract: STAGE_CLOSURE_CONTRACT,
        external: stage === "discovery" ? [{ kind: "repository" as const, basis: f5.source }] : [] } };
  }) as StageValidator])) as StageValidators;
  const pipeline5 = new Pipeline(f5.store, validators5, { repository: repositoryCheck });
  const draft5 = pipeline5.draft("garden", "discovery", { title: "Garden" }, 0);
  pipeline5.accept("garden", "discovery", draft5.revision);
  f5.calls.set("discovery", 0);
  assert.equal(pipeline5.inspect("garden", "discovery").state, "accepted");
  assert.equal(f5.calls.get("discovery"), 0, "the registered executor ran inside the closed read");
});

test("a saved admission breach stays stale on every read path — the fallback never re-admits (№6232 G1-01)", t => {
  // The validator forms its admission DYNAMICALLY: the record's current head when it exists, an absent
  // guard otherwise. A diagnostic re-run lawfully mints a NEW admission — so if the saved condition were
  // only checked on the snapshot path, every other path would launder the breach into a fresh accept.
  for (const path of ["snapshot", "opaque", "pf4"] as const)
    for (const mode of ["absent", "positive"] as const) {
      const f = fixture(t);
      const id = `admission:garden:${mode}`;
      let dependency: Ref | null = null;
      if (mode === "positive")
        dependency = reference(f.store.write({ id, kind: "evidence", expected: 0, value: { same: true } }));
      let calls = 0;
      const validators = Object.fromEntries(STAGES.map(stage => [stage, (() => {
        calls += 1;
        const head = f.store.get(id);
        return { findings: [], guards: [],
          admissionGuards: [head ? reference(head) : { id, absent: true } as TransactionGuard],
          closure: { contract: STAGE_CLOSURE_CONTRACT, external: [] } };
      }) as StageValidator])) as StageValidators;
      const pipeline = new Pipeline(f.store, validators);
      const draft = pipeline.draft("garden", "discovery", { title: "Garden" }, 0);
      pipeline.accept("garden", "discovery", draft.revision);
      assert.equal(pipeline.inspect("garden", "discovery").state, "accepted", `${path}/${mode}`);
      f.store.write({ id, kind: "evidence", expected: dependency?.revision ?? 0, value: { same: true } });
      calls = 0;
      const check = (): StageProjection => {
        if (path === "snapshot") return pipeline.inspect("garden", "discovery");
        if (path === "opaque") {
          const view = new Proxy(f.store, { get: (target, key) => {
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          } });
          return new Pipeline(view, validators).inspect("garden", "discovery");
        }
        return withHistoricalReads(() => historicalRead(f.store,
          { reader: "M6.route-result", project: "garden", ref: f.source },
          () => pipeline.inspect("garden", "discovery"), () => { throw new Error("cycle"); }));
      };
      const projection = check();
      assert.equal(projection.state, "stale",
        `${path}/${mode}: the saved admission breach is the refusal, not a fresh accept`);
      assert.ok(projection.findings.some(finding => finding.code === "input_stale" && finding.target === id),
        `${path}/${mode}: the breach is addressed to the moved dependency`);
      assert.equal(calls, 0, `${path}/${mode}: the validator never supplied a new admission`);
    }
});

test("a record's commit guards are not proofs: a moved write-only dependency keeps the stage accepted", t => {
  const f = fixture(t);
  const graphHead = reference(f.store.write({ id: "graph:garden", kind: "graph", expected: 0, value: {} }));
  const pipeline = f.pipeline();
  const draft = pipeline.draft("garden", "discovery", { title: "Garden" }, 0);
  const accepted = pipeline.accept("garden", "discovery", draft.revision, [graphHead]);
  const closure = closureOf(accepted);
  assert.ok(closure.writeGuards.some(guard => 'revision' in guard && guard.id === graphHead.id));
  assert.ok(!closure.proofs.some(ref => ref.id === graphHead.id));
  f.store.write({ id: graphHead.id, kind: "graph", expected: graphHead.revision, value: { moved: true } });
  f.calls.set("discovery", 0);
  const projection = pipeline.inspect("garden", "discovery");
  assert.equal(projection.state, "accepted");
  assert.equal(f.calls.get("discovery"), 0, "writeGuards are never read back as proofs");
});

test("without an explicit declaration no closure is written; an unclosed predecessor keeps the stage unclosed", t => {
  const f = fixture(t);
  const silent = f.pipeline({ declareStage: () => false });
  const draft = silent.draft("garden", "discovery", { title: "Garden" }, 0);
  const accepted = silent.accept("garden", "discovery", draft.revision);
  assert.equal(accepted.value.closure, undefined);
  f.calls.set("discovery", 0);
  assert.equal(silent.inspect("garden", "discovery").state, "accepted");
  assert.equal(f.calls.get("discovery"), 1, "no closure means the validator still answers");
  // The second stage's validator declares, but its accepted predecessor recorded no closure.
  const mixed = f.pipeline({ declareStage: stage => stage !== "discovery" });
  const conceptDraft = mixed.draft("garden", "concept", { title: "Concept" }, 0);
  const concept = mixed.accept("garden", "concept", conceptDraft.revision);
  assert.equal(concept.value.closure, undefined, "the predecessor's unknown externals cannot be covered");
  f.calls.set("concept", 0);
  assert.equal(mixed.inspect("garden", "concept").state, "accepted");
  assert.equal(f.calls.get("concept"), 1);
});

test("a malformed or foreign closure is an addressed stage_closure_invalid refusal, never a silent fallback", t => {
  const f = fixture(t);
  const pipeline = f.pipeline();
  const writeStage = (name: string, closure: unknown): StageRevision => {
    const head = f.store.get("stage:garden:discovery");
    return f.store.write<StageArtifact>({ id: "stage:garden:discovery", kind: "stage",
      expected: head?.revision ?? 0,
      value: { projectId: "garden", stage: "discovery", status: "accepted", content: { title: name },
        inputs: [], proofs: [], closure: closure as StageClosure } });
  };
  const cases: [string, unknown][] = [
    ["foreign contract", { contract: "stage-closure/v2", proofs: [], admission: [], inherited: [], external: [], writeGuards: [] }],
    ["proof mismatch", { contract: STAGE_CLOSURE_CONTRACT,
      proofs: [{ id: "other", revision: 1, hash: digest("x") }], admission: [], inherited: [], external: [], writeGuards: [] }],
    ["unknown check kind", { contract: STAGE_CLOSURE_CONTRACT,
      proofs: [], admission: [], inherited: [], external: [{ kind: "magic" }], writeGuards: [] }],
    ["malformed admission", { contract: STAGE_CLOSURE_CONTRACT,
      proofs: [], admission: [{ id: "x" }], inherited: [], external: [], writeGuards: [] }],
    ["malformed write guards", { contract: STAGE_CLOSURE_CONTRACT,
      proofs: [], admission: [], inherited: [], external: [], writeGuards: [{ id: "x", absent: false }] }],
  ];
  f.calls.set("discovery", 0);
  for (const [name, closure] of cases) {
    const artifact = writeStage(name, closure);
    const projection = pipeline.inspect("garden", "discovery");
    assert.equal(projection.state, "stale", name);
    assert.ok(projection.findings.some(finding => finding.code === "stage_closure_invalid" && finding.target === artifact.id), name);
    assert.equal(f.calls.get("discovery"), 0, `the validator never ran: ${name}`);
  }
});

test("closed reads use the snapshot only outside an active PF4 capture; inside it every head is read observably", t => {
  const f = fixture(t);
  const pipeline = f.pipeline();
  acceptAll(pipeline, "garden", ["discovery", "concept"]);
  const parsed = storeBodyCache().parses;
  const outside = reads(() => pipeline.inspect("garden", "concept"));
  const outsideParses = storeBodyCache().parses - parsed;
  assert.equal(outside, 3);
  f.calls.set("concept", 0);
  const inside = withHistoricalReads(() => historicalRead(f.store,
    { reader: "M6.route-result", project: "garden", ref: f.source }, () => {
      const before = { reads: storeReads(), parses: storeBodyCache().parses };
      const state = pipeline.inspect("garden", "concept").state;
      return { state, insideReads: storeReads() - before.reads, insideParses: storeBodyCache().parses - before.parses };
    }, () => { throw new Error("cycle"); }));
  assert.equal(inside.state, "accepted");
  assert.equal(inside.insideReads, 1 + 1 + 1,
    "the capture records every saved guard as an observable get: artifact body, proof head, source body");
  assert.ok(inside.insideParses > outsideParses,
    "every guard body the snapshot skips is decoded inside the capture — the journal sees them all");
  assert.equal(f.calls.get("concept"), 0,
    "the closed read stays closed inside the capture — the saved guards are its journal records");
  f.calls.set("concept", 0);
  assert.equal(reads(() => pipeline.inspect("garden", "concept")), 3, "and the snapshot path returns outside it");
});

test("the read budget of a closed prefix counts stages and dependencies, not history or neighbors", t => {
  const f = fixture(t);
  const pipeline = f.pipeline();
  const stages: Stage[] = ["discovery", "concept", "operation-map", "specification", "features"];
  acceptAll(pipeline, "garden", stages);
  const measure = () => reads(() => {
    for (const stage of stages) assert.equal(pipeline.inspect("garden", stage).state, "accepted");
    const projections = pipeline.project("garden");
    assert.deepEqual(projections.map(projection => projection.state),
      [...stages.map(() => "accepted"), "missing", "missing", "missing"]);
  });
  const before = measure();
  // 10× history and another project's prefix: the same scenario, the same number of reads.
  for (let index = 0; index < 500; index++) {
    const record = f.store.write({ id: `other:${index}`, kind: "noise", expected: 0, value: { index } });
    for (let revision = 0; revision < 9; revision++)
      f.store.write({ id: record.id, kind: "noise", expected: revision + 1, value: { index, revision } });
  }
  acceptAll(pipeline, "neighbor", stages);
  const after = measure();
  assert.equal(after, before, "grown history and a foreign project add no reads to the closed prefix");
  assert.ok(before <= 3 * stages.length + 3 * STAGES.length,
    "each stage costs one artifact body, one heads snapshot and its declared source reads");
});

// №6254 (стык G1 → G2b): an accepted execution with a completed result consumes a SEALED compilation —
// its full path never re-inspects the compilation, only guards its head. Its closure must say the same:
// none of the compilation's external checks is inherited, and the compilation's admission is no
// condition of its later reads; its own declared checks and its own admission still are.
const COMPILATION = STAGES[6]!;
const sealedPrefix = (f: Fixture, pipeline: Pipeline) => {
  const result = reference(f.store.write({ id: "result:garden", kind: "result", expected: 0, value: {} }));
  acceptAll(pipeline, "garden", [...STAGES.slice(0, 7)]);
  return { id: result.id, revision: result.revision, hash: result.hash };
};

test("a sealed execution inherits none of its compilation's external checks — the rotting committed prefix leaves its closed read accepted (№6254)", t => {
  const f = fixture(t);
  const pipeline = f.pipeline({ external: { execution: [] } });
  const result = sealedPrefix(f, pipeline);
  const compilation = closureOf(f.store.get<StageArtifact>(`stage:garden:${COMPILATION}`)!);
  assert.ok([...compilation.inherited, ...compilation.external].some(check => check.kind === "source"),
    "the compilation itself carries the committed source check");
  const draft = pipeline.draft("garden", "execution", { title: "Run", result }, 0);
  const execution = pipeline.accept("garden", "execution", draft.revision);
  assert.deepEqual(closureOf(execution).inherited, [], "nothing of the sealed compilation is inherited");
  writeFileSync(f.file, "rot");
  f.calls.set("execution", 0); f.calls.set(COMPILATION, 0);
  assert.equal(pipeline.inspect("garden", "execution").state, "accepted");
  assert.deepEqual([f.calls.get("execution"), f.calls.get(COMPILATION)], [0, 0],
    "the closed read stays closed and the compilation is not re-inspected — historical evidence never invalidates the result");
  assert.equal(pipeline.inspect("garden", COMPILATION).state, "stale", "the compilation's own read still sees its rot");
});

test("a sealed execution's own check that falls back still answers through the full path's sealed exception (№6254)", t => {
  const f = fixture(t);
  const anchor = reference(f.store.write({ id: "repository:garden", kind: "repository", expected: 0, value: {} }));
  // No executor is registered for `repository`: the closed read falls back, never a silent pass.
  const pipeline = f.pipeline({ external: { execution: [{ kind: "repository", basis: anchor }] } });
  const result = sealedPrefix(f, pipeline);
  const execution = pipeline.accept("garden", "execution", pipeline.draft("garden", "execution", { title: "Run", result }, 0).revision);
  assert.deepEqual(closureOf(execution).inherited, []);
  writeFileSync(f.file, "rot");
  f.calls.set("execution", 0); f.calls.set(COMPILATION, 0);
  assert.equal(pipeline.inspect("garden", "execution").state, "accepted");
  assert.deepEqual([f.calls.get("execution"), f.calls.get(COMPILATION)], [1, 0],
    "the full path ran the execution's validator and reached the sealed exception without re-inspecting the compilation");
});

test("an execution without a completed result still inherits its compilation's checks and re-inspects a rotting prefix (№6254 control)", t => {
  const f = fixture(t);
  const pipeline = f.pipeline({ external: { execution: [] } });
  sealedPrefix(f, pipeline);
  const execution = pipeline.accept("garden", "execution", pipeline.draft("garden", "execution", { title: "Run" }, 0).revision);
  assert.ok(closureOf(execution).inherited.some(check => check.kind === "source"), "an unsealed execution inherits the prefix's checks");
  writeFileSync(f.file, "rot");
  const projection = pipeline.inspect("garden", "execution");
  assert.equal(projection.state, "stale");
  assert.ok(projection.findings.some(finding => finding.code === "input_stale" && finding.target === `stage:garden:${COMPILATION}`),
    "the inherited check missed and the full path re-inspected the compilation, which the rot made stale");
});

test("a sealed execution keeps its own admission and never the compilation's; a registered compilation check is never run for it (№6254)", t => {
  const f = fixture(t);
  const repository = reference(f.store.write({ id: "repository:garden", kind: "repository", expected: 0, value: { head: 1 } }));
  const moving = reference(f.store.write({ id: "compilation-admission:garden", kind: "evidence", expected: 0, value: {} }));
  const own = reference(f.store.write({ id: "execution-admission:garden", kind: "evidence", expected: 0, value: {} }));
  let repositoryChecks = 0;
  const handlers: ExternalCheckHandlers = { repository: (check, context) => {
    repositoryChecks++;
    const head = context.store.get(check.basis.id);
    return head && head.revision === check.basis.revision && head.hash === check.basis.hash ? null
      : { code: "repository_changed", target: check.basis.id, message: "The repository moved" };
  } };
  const pipeline = f.pipeline({ handlers,
    external: { [COMPILATION]: [{ kind: "source", ref: f.source }, { kind: "repository", basis: repository }] },
    extraAdmission: { [COMPILATION]: [moving], execution: [own] } });
  const result = sealedPrefix(f, pipeline);
  const execution = pipeline.accept("garden", "execution", pipeline.draft("garden", "execution", { title: "Run", result }, 0).revision);
  const closure = closureOf(execution);
  assert.deepEqual(closure.inherited, []);
  assert.ok(closure.admission.some(guard => guard.id === own.id), "its own admission is a condition of its later reads");
  assert.ok(!closure.admission.some(guard => guard.id === moving.id), "the compilation's admission is not");
  // The execution's commits move the repository and the compilation's admission record.
  f.store.write({ id: repository.id, kind: "repository", expected: repository.revision, value: { head: 2 } });
  f.store.write({ id: moving.id, kind: "evidence", expected: moving.revision, value: { moved: true } });
  repositoryChecks = 0; f.calls.set("execution", 0); f.calls.set(COMPILATION, 0);
  assert.equal(pipeline.inspect("garden", "execution").state, "accepted");
  assert.deepEqual([repositoryChecks, f.calls.get("execution"), f.calls.get(COMPILATION)], [0, 0, 0],
    "no historical repository check and no re-inspection after the execution's commits");
  assert.equal(pipeline.inspect("garden", COMPILATION).state, "stale", "the compilation's own read still answers its moved admission");
  // Its own admission stays enforced on every path (№6232 G1-01).
  f.store.write({ id: own.id, kind: "evidence", expected: own.revision, value: { moved: true } });
  const moved = pipeline.inspect("garden", "execution");
  assert.equal(moved.state, "stale");
  assert.ok(moved.findings.some(finding => finding.code === "input_stale" && finding.target === own.id));
});

test("a guard that moves between inspection and the acceptance write still refuses input_stale", t => {
  const f = fixture(t);
  const moving = reference(f.store.write({ id: "moving:garden", kind: "evidence", expected: 0, value: {} }));
  const pipeline = f.pipeline({ extraGuards: { discovery: [moving] } });
  const draft = pipeline.draft("garden", "discovery", { title: "Garden" }, 0);
  f.store.write({ id: moving.id, kind: "evidence", expected: moving.revision, value: { moved: true } });
  assert.throws(() => pipeline.accept("garden", "discovery", draft.revision), code("input_stale"));
  assert.deepEqual(f.store.get(draft.id), draft, "nothing was written — neither stage nor closure");
});
